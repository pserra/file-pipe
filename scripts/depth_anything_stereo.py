#!/usr/bin/env python3
"""Depth Anything based 2D-to-SBS HLS segment helper for File Pipe.

This script is intentionally process-oriented: the connector invokes it for one
HLS segment at a time and expects an MPEG-TS segment at --output.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image


PYTORCH_SMALL_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
PYTORCH_BASE_MODEL = "depth-anything/Depth-Anything-V2-Base-hf"
COREML_SMALL_REPO = "apple/coreml-depth-anything-v2-small"
COREML_SMALL_PACKAGE = "DepthAnythingV2SmallF16.mlpackage"


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True, **kwargs)


def media_tool(name):
    env_name = f"FILE_PIPE_{name.upper()}_PATH"
    configured = os.environ.get(env_name, "").strip()
    if configured:
        return configured
    found = shutil.which(name)
    if found:
        return found
    for directory in (
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ):
        candidate = Path(directory) / name
        if candidate.exists():
            return str(candidate)
    return name


def ffprobe_json(input_url):
    completed = run(
        [
            media_tool("ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,avg_frame_rate",
            "-of",
            "json",
            input_url,
        ]
    )
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError("ffprobe did not find a video stream.")
    return streams[0]


def parse_rate(value, default=24.0):
    if not value or value == "0/0":
        return default
    if "/" in value:
        num, den = value.split("/", 1)
        den_value = float(den or 1)
        return float(num or 0) / den_value if den_value else default
    return float(value)


def even(value):
    return max(2, int(value) - (int(value) % 2))


def bounded_float(value, default, minimum=0.1, maximum=1.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(minimum, min(maximum, number))


def target_geometry(stream, max_width, fps, resolution_scale):
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError("ffprobe returned invalid video dimensions.")
    scale = bounded_float(resolution_scale, 1.0)
    if not resolution_scale and max_width:
        scale = min(scale, float(max_width) / float(width))
    target_width = even(width * scale)
    target_height = even(height * scale)
    source_fps = parse_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate"), fps)
    target_fps = min(float(fps), source_fps) if source_fps > 0 else float(fps)
    return target_width, target_height, max(1.0, target_fps)


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    if remaining:
        return b""
    return b"".join(chunks)


class TorchDepthAnything:
    def __init__(self, model_id):
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        self.torch = torch
        self.processor = AutoImageProcessor.from_pretrained(model_id)
        self.model = AutoModelForDepthEstimation.from_pretrained(model_id)
        self.device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        self.model.to(self.device)
        self.model.eval()

    def predict(self, frame):
        image = Image.fromarray(frame)
        inputs = self.processor(images=image, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.no_grad():
            outputs = self.model(**inputs)
        prediction = self.torch.nn.functional.interpolate(
            outputs.predicted_depth.unsqueeze(1),
            size=(frame.shape[0], frame.shape[1]),
            mode="bicubic",
            align_corners=False,
        )
        return prediction.squeeze().detach().cpu().numpy()


class CoreMLDepthAnything:
    def __init__(self, model_path=""):
        import coremltools as ct

        resolved = Path(model_path).expanduser() if model_path else resolve_coreml_model()
        if not resolved.exists():
            raise RuntimeError(f"Core ML model package was not found: {resolved}")
        self.model = ct.models.MLModel(str(resolved), compute_units=ct.ComputeUnit.ALL)
        spec = self.model.get_spec()
        self.input_name = spec.description.input[0].name
        input_type = spec.description.input[0].type
        self.image_width = 518
        self.image_height = 392
        if input_type.WhichOneof("Type") == "imageType":
            image_type = input_type.imageType
            self.image_width = int(image_type.width or self.image_width)
            self.image_height = int(image_type.height or self.image_height)

    def predict(self, frame):
        image = Image.fromarray(frame).resize((self.image_width, self.image_height), Image.Resampling.BICUBIC)
        outputs = self.model.predict({self.input_name: image})
        depth = None
        for value in outputs.values():
            array = np.asarray(value)
            if array.size > 1:
                depth = array
                break
        if depth is None:
            raise RuntimeError("Core ML model did not return a depth tensor.")
        depth = np.squeeze(depth).astype(np.float32)
        depth_image = Image.fromarray(normalize_depth(depth) * 255.0).convert("L")
        depth_image = depth_image.resize((frame.shape[1], frame.shape[0]), Image.Resampling.BICUBIC)
        return np.asarray(depth_image, dtype=np.float32) / 255.0


def resolve_coreml_model():
    from huggingface_hub import snapshot_download

    snapshot = Path(
        snapshot_download(
            COREML_SMALL_REPO,
            allow_patterns=[f"{COREML_SMALL_PACKAGE}/**"],
        )
    )
    candidates = list(snapshot.rglob(COREML_SMALL_PACKAGE))
    if not candidates:
        raise RuntimeError(f"{COREML_SMALL_PACKAGE} was not found in {COREML_SMALL_REPO}.")
    source = candidates[0]
    target = Path(__file__).resolve().parent / "models" / COREML_SMALL_PACKAGE
    weight_file = target / "Data" / "com.apple.CoreML" / "weights" / "weight.bin"
    if not weight_file.exists():
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, symlinks=False)
    return target


def normalize_depth(depth):
    depth = np.asarray(depth, dtype=np.float32)
    finite = np.isfinite(depth)
    if not finite.any():
        return np.zeros(depth.shape, dtype=np.float32)
    values = depth[finite]
    low = np.percentile(values, 2)
    high = np.percentile(values, 98)
    if high <= low:
        low = float(values.min())
        high = float(values.max())
    if high <= low:
        return np.zeros(depth.shape, dtype=np.float32)
    normalized = (depth - low) / (high - low)
    return np.clip(normalized, 0.0, 1.0).astype(np.float32)


def resize_rgb(frame, width, height):
    if frame.shape[1] == width and frame.shape[0] == height:
        return frame
    image = Image.fromarray(frame)
    return np.asarray(image.resize((width, height), Image.Resampling.BICUBIC), dtype=np.uint8)


def resize_depth(depth, width, height):
    depth_image = Image.fromarray(normalize_depth(depth) * 255.0).convert("L")
    depth_image = depth_image.resize((width, height), Image.Resampling.BICUBIC)
    return np.asarray(depth_image, dtype=np.float32) / 255.0


def inference_frame_geometry(width, height, inference_scale):
    scale = bounded_float(inference_scale, 0.5)
    return even(width * scale), even(height * scale)


def inference_crop(width, crop_percent):
    percent = max(0.0, min(25.0, float(crop_percent or 0.0))) / 100.0
    crop = int(width * percent)
    if crop <= 0 or crop * 2 >= width - 4:
        return 0, width
    return crop, width - crop


def predict_depth(estimator, frame, inference_scale=0.5, inference_crop_percent=0.0):
    height, width = frame.shape[:2]
    crop_left, crop_right = inference_crop(width, inference_crop_percent)
    reference = frame[:, crop_left:crop_right]
    ref_height, ref_width = reference.shape[:2]
    infer_width, infer_height = inference_frame_geometry(ref_width, ref_height, inference_scale)
    inference_frame = resize_rgb(reference, infer_width, infer_height)
    depth = estimator.predict(inference_frame)
    depth = resize_depth(depth, ref_width, ref_height)
    if crop_left == 0 and crop_right == width:
        return depth
    full_depth = np.empty((height, width), dtype=np.float32)
    full_depth[:, crop_left:crop_right] = depth
    full_depth[:, :crop_left] = depth[:, :1]
    full_depth[:, crop_right:] = depth[:, -1:]
    return full_depth


def make_stereo(frame, depth, layout, depth_percent, invert_depth=False):
    import cv2

    height, width = frame.shape[:2]
    depth_map = normalize_depth(depth)
    if invert_depth:
        depth_map = 1.0 - depth_map
    max_shift = max(1.0, width * (float(depth_percent) / 100.0))
    disparity = (depth_map - 0.5) * max_shift
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    left = cv2.remap(
        frame,
        (grid_x + disparity * 0.5).astype(np.float32),
        grid_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    right = cv2.remap(
        frame,
        (grid_x - disparity * 0.5).astype(np.float32),
        grid_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    if layout == "full-sbs":
        return np.concatenate([left, right], axis=1)
    half_width = even(width / 2)
    left_half = cv2.resize(left, (half_width, height), interpolation=cv2.INTER_AREA)
    right_half = cv2.resize(right, (half_width, height), interpolation=cv2.INTER_AREA)
    return np.concatenate([left_half, right_half], axis=1)


def build_depth_estimator(args):
    if args.processor == "coreml-depth-anything-v2-small":
        return CoreMLDepthAnything(args.model_path)
    model_id = args.model or (PYTORCH_BASE_MODEL if args.processor == "depth-anything-v2-base" else PYTORCH_SMALL_MODEL)
    return TorchDepthAnything(model_id)


def warmup(args):
    estimator = build_depth_estimator(args)
    frame = np.zeros((128, 128, 3), dtype=np.uint8)
    depth = estimator.predict(frame)
    print(f"{args.processor} ready; depth shape={tuple(depth.shape)}")


def process_segment(args):
    stream = ffprobe_json(args.input)
    width, height, fps = target_geometry(stream, args.max_width, args.fps, args.resolution_scale)
    out_width = width * 2 if args.layout == "full-sbs" else width
    frame_size = width * height * 3
    estimator = build_depth_estimator(args)

    decoder = subprocess.Popen(
        [
            media_tool("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(args.start),
            "-i",
            args.input,
            "-t",
            str(args.duration),
            "-an",
            "-vf",
            f"fps={fps:.3f},scale={width}:{height}",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    encoder = subprocess.Popen(
        [
            media_tool("ffmpeg"),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{out_width}x{height}",
            "-r",
            f"{fps:.3f}",
            "-i",
            "pipe:0",
            "-ss",
            str(args.start),
            "-i",
            args.input,
            "-t",
            str(args.duration),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            args.preset,
            "-tune",
            "zerolatency",
            "-profile:v",
            "high",
            "-level:v",
            "5.1" if args.layout == "full-sbs" else "4.1",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-mpegts_flags",
            "+resend_headers",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-f",
            "mpegts",
            args.output,
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    frames = 0
    try:
        assert decoder.stdout is not None
        assert encoder.stdin is not None
        while True:
            raw = read_exact(decoder.stdout, frame_size)
            if not raw:
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
            depth = predict_depth(estimator, frame, args.inference_scale, args.inference_crop_percent)
            stereo = make_stereo(frame, depth, args.layout, args.depth_percent, args.invert_depth)
            encoder.stdin.write(stereo.astype(np.uint8).tobytes())
            frames += 1
    finally:
        if encoder.stdin:
            encoder.stdin.close()
        decoder_stderr = decoder.stderr.read().decode("utf-8", "replace") if decoder.stderr else ""
        encoder_stderr = encoder.stderr.read().decode("utf-8", "replace") if encoder.stderr else ""
        decoder.wait()
        encoder.wait()

    if decoder.returncode:
        raise RuntimeError(f"ffmpeg decode failed: {decoder_stderr.strip()}")
    if encoder.returncode:
        raise RuntimeError(f"ffmpeg encode failed: {encoder_stderr.strip()}")
    if frames <= 0:
        raise RuntimeError("No frames were decoded from the requested segment.")


def parse_args():
    parser = argparse.ArgumentParser(description="Create SBS HLS segment with Depth Anything.")
    parser.add_argument("--processor", choices=["depth-anything-v2-small", "depth-anything-v2-base", "coreml-depth-anything-v2-small"], required=True)
    parser.add_argument("--input", help="Input URL or file path.")
    parser.add_argument("--output", help="Output MPEG-TS segment path.")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float, default=4.0)
    parser.add_argument("--layout", choices=["half-sbs", "full-sbs"], default="half-sbs")
    parser.add_argument("--video-profile", default="")
    parser.add_argument("--depth-percent", type=float, default=3.5)
    parser.add_argument("--resolution-scale", type=float, default=float(os.environ.get("FILE_PIPE_DEPTH_RESOLUTION_SCALE", "1")))
    parser.add_argument("--inference-scale", type=float, default=float(os.environ.get("FILE_PIPE_DEPTH_INFERENCE_SCALE", "0.5")))
    parser.add_argument("--inference-crop-percent", type=float, default=float(os.environ.get("FILE_PIPE_DEPTH_INFERENCE_CROP_PERCENT", "0")))
    parser.add_argument("--max-width", type=int, default=int(os.environ.get("FILE_PIPE_DEPTH_MAX_WIDTH", "960")))
    parser.add_argument("--fps", type=float, default=float(os.environ.get("FILE_PIPE_DEPTH_FPS", "24")))
    parser.add_argument("--preset", default=os.environ.get("FILE_PIPE_DEPTH_X264_PRESET", "veryfast"))
    parser.add_argument("--model", default=os.environ.get("FILE_PIPE_DEPTH_ANYTHING_MODEL", ""))
    parser.add_argument("--model-path", default=os.environ.get("FILE_PIPE_COREML_DEPTH_ANYTHING_MODEL_PATH", ""))
    parser.add_argument("--invert-depth", action="store_true")
    parser.add_argument("--warmup", action="store_true", help="Load the model and run one tiny prediction, then exit.")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.warmup:
        warmup(args)
        return 0
    if not args.input or not args.output:
        raise SystemExit("--input and --output are required unless --warmup is used.")
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    process_segment(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
