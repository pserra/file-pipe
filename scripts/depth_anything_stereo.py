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
import time
from pathlib import Path

import numpy as np
from PIL import Image


PYTORCH_SMALL_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
PYTORCH_BASE_MODEL = "depth-anything/Depth-Anything-V2-Base-hf"
DA3_SMALL_MODEL = "depth-anything/DA3-SMALL"
DA3_BASE_MODEL = "depth-anything/DA3-BASE"
COREML_SMALL_REPO = "apple/coreml-depth-anything-v2-small"
COREML_SMALL_PACKAGE = "DepthAnythingV2SmallF16.mlpackage"
DA3_PROCESSORS = {"depth-anything-v3-small", "depth-anything-v3-base"}


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


def atomic_write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f".{os.getpid()}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    temp_path.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return default


def resolve_process_res(width, height, inference_scale):
    scale = bounded_float(inference_scale, 0.6)
    return even(max(width, height) * scale)


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


class DepthAnything3Estimator:
    def __init__(self, model_id):
        import types

        import torch

        # The public DA3 API imports optional export/pose helpers at module import
        # time. File Pipe only needs inference here, so keep those heavyweight
        # extras optional for the local depth helper environment.
        if "depth_anything_3.utils.export" not in sys.modules:
            export_stub = types.ModuleType("depth_anything_3.utils.export")

            def _unused_export(*_args, **_kwargs):
                raise RuntimeError("Depth Anything 3 export helpers are not installed in this File Pipe helper.")

            export_stub.export = _unused_export
            sys.modules["depth_anything_3.utils.export"] = export_stub
        if "depth_anything_3.utils.pose_align" not in sys.modules:
            pose_stub = types.ModuleType("depth_anything_3.utils.pose_align")

            def _unused_align(*_args, **_kwargs):
                raise RuntimeError("Depth Anything 3 pose alignment extras are not installed in this File Pipe helper.")

            pose_stub.align_poses_umeyama = _unused_align
            pose_stub.batch_align_poses_umeyama = _unused_align
            sys.modules["depth_anything_3.utils.pose_align"] = pose_stub

        try:
            from depth_anything_3.api import DepthAnything3
        except ImportError as exc:
            raise RuntimeError(
                "Depth Anything 3 is not installed in the depth helper venv. "
                "Run scripts/setup_depth_processors.sh again to install the DA3 helper package."
            ) from exc

        self.torch = torch
        self.model_id = model_id
        self.model = DepthAnything3.from_pretrained(model_id)
        if torch.cuda.is_available():
            self.device = torch.device("cuda")
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")
        self.model.to(device=self.device)
        self.model.eval()

    def predict(self, frame):
        depth = self.predict_sequence([frame], process_res=max(frame.shape[:2]))[0]
        return depth

    def predict_sequence(self, frames, process_res, process_res_method="upper_bound_resize", ref_view_strategy="saddle_balanced"):
        if not frames:
            return []
        with self.torch.inference_mode():
            prediction = self.model.inference(
                list(frames),
                process_res=int(max(64, process_res)),
                process_res_method=process_res_method,
                ref_view_strategy=ref_view_strategy,
            )
        return [np.asarray(depth, dtype=np.float32) for depth in prediction.depth]


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


def smooth_depth_sequence(depths, smoothing):
    amount = bounded_float(smoothing, 0.0, 0.0, 0.95)
    if amount <= 0 or len(depths) <= 1:
        return depths
    smoothed = []
    previous = None
    for depth in depths:
        current = normalize_depth(depth)
        if previous is None:
            blended = current
        else:
            blended = previous * amount + current * (1.0 - amount)
        smoothed.append(blended.astype(np.float32))
        previous = blended
    return smoothed


def predict_depth_sequence(
    estimator,
    frames,
    inference_scale=0.6,
    inference_crop_percent=0.0,
    process_res_method="upper_bound_resize",
    ref_view_strategy="saddle_balanced",
    temporal_smoothing=0.18,
):
    if not frames:
        return []
    height, width = frames[0].shape[:2]
    crop_left, crop_right = inference_crop(width, inference_crop_percent)
    references = [frame[:, crop_left:crop_right] for frame in frames]
    ref_height, ref_width = references[0].shape[:2]
    if hasattr(estimator, "predict_sequence"):
        process_res = resolve_process_res(ref_width, ref_height, inference_scale)
        depths = estimator.predict_sequence(references, process_res, process_res_method, ref_view_strategy)
        depths = [resize_depth(depth, ref_width, ref_height) for depth in depths]
    else:
        depths = [
            predict_depth(estimator, frame, inference_scale, inference_crop_percent)
            for frame in frames
        ]
        return smooth_depth_sequence(depths, temporal_smoothing)
    if crop_left != 0 or crop_right != width:
        expanded = []
        for depth in depths:
            full_depth = np.empty((height, width), dtype=np.float32)
            full_depth[:, crop_left:crop_right] = depth
            full_depth[:, :crop_left] = depth[:, :1]
            full_depth[:, crop_right:] = depth[:, -1:]
            expanded.append(full_depth)
        depths = expanded
    return smooth_depth_sequence(depths, temporal_smoothing)


def predict_depth_sequence_windowed(
    estimator,
    frames,
    inference_scale=0.6,
    inference_crop_percent=0.0,
    process_res_method="upper_bound_resize",
    ref_view_strategy="saddle_balanced",
    temporal_smoothing=0.18,
    window_frames=18,
    overlap_frames=6,
):
    if not frames:
        return []
    window = max(1, int(window_frames or len(frames)))
    overlap = max(0, min(int(overlap_frames or 0), window - 1))
    if len(frames) <= window:
        return predict_depth_sequence(
            estimator,
            frames,
            inference_scale,
            inference_crop_percent,
            process_res_method,
            ref_view_strategy,
            temporal_smoothing,
        )
    step = max(1, window - overlap)
    accum = [None] * len(frames)
    counts = [0] * len(frames)
    for start in range(0, len(frames), step):
        end = min(len(frames), start + window)
        if end <= start:
            break
        chunk_depths = predict_depth_sequence(
            estimator,
            frames[start:end],
            inference_scale,
            inference_crop_percent,
            process_res_method,
            ref_view_strategy,
            0.0,
        )
        for offset, depth in enumerate(chunk_depths):
            index = start + offset
            if accum[index] is None:
                accum[index] = depth.astype(np.float32)
            else:
                accum[index] += depth.astype(np.float32)
            counts[index] += 1
        if end >= len(frames):
            break
    depths = []
    previous = None
    for index, total in enumerate(accum):
        if total is None:
            if previous is None:
                total = predict_depth(estimator, frames[index], inference_scale, inference_crop_percent)
                count = 1
            else:
                depths.append(previous.copy())
                continue
        else:
            count = max(1, counts[index])
        depth = (total / count).astype(np.float32)
        depths.append(depth)
        previous = depth
    return smooth_depth_sequence(depths, temporal_smoothing)


def expand_sparse_depths(key_indices, key_depths, frame_count):
    if not key_indices or not key_depths:
        return []
    depths = [None] * frame_count
    normalized = [normalize_depth(depth) for depth in key_depths]
    for slot, index in enumerate(key_indices):
        depths[index] = normalized[slot]
    for slot in range(len(key_indices) - 1):
        left_index = key_indices[slot]
        right_index = key_indices[slot + 1]
        left_depth = normalized[slot]
        right_depth = normalized[slot + 1]
        distance = max(1, right_index - left_index)
        for index in range(left_index + 1, right_index):
            alpha = (index - left_index) / distance
            depths[index] = normalize_depth(left_depth * (1.0 - alpha) + right_depth * alpha)
    first_index = key_indices[0]
    for index in range(0, first_index):
        depths[index] = normalized[0]
    last_index = key_indices[-1]
    for index in range(last_index + 1, frame_count):
        depths[index] = normalized[-1]
    return depths


def predict_realtime_depths(
    estimator,
    frames,
    inference_scale=0.33,
    inference_crop_percent=0.0,
    process_res_method="upper_bound_resize",
    ref_view_strategy="saddle_balanced",
    temporal_smoothing=0.10,
    window_frames=8,
    overlap_frames=2,
    depth_frame_stride=1,
):
    stride = max(1, int(depth_frame_stride or 1))
    if stride <= 1 or len(frames) <= 2:
        return predict_depth_sequence_windowed(
            estimator,
            frames,
            inference_scale,
            inference_crop_percent,
            process_res_method,
            ref_view_strategy,
            temporal_smoothing,
            window_frames,
            overlap_frames,
        )
    key_indices = list(range(0, len(frames), stride))
    if key_indices[-1] != len(frames) - 1:
        key_indices.append(len(frames) - 1)
    key_frames = [frames[index] for index in key_indices]
    key_depths = predict_depth_sequence_windowed(
        estimator,
        key_frames,
        inference_scale,
        inference_crop_percent,
        process_res_method,
        ref_view_strategy,
        temporal_smoothing,
        window_frames,
        overlap_frames,
    )
    return expand_sparse_depths(key_indices, key_depths, len(frames))


def make_stereo(frame, depth, layout, depth_percent, invert_depth=False):
    import cv2

    return make_stereo_remap(frame, depth, layout, depth_percent, invert_depth)


def make_stereo_remap(frame, depth, layout, depth_percent, invert_depth=False):
    import cv2

    frame = repair_vertical_edge_bars(frame)
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


def forward_warp_view(frame, shift, direction, inpaint_radius):
    import cv2

    height, width = frame.shape[:2]
    grid_x = np.broadcast_to(np.arange(width, dtype=np.float32), (height, width))
    target_x = np.rint(grid_x + shift * direction).astype(np.int32)
    valid = (target_x >= 0) & (target_x < width)
    target_y = np.broadcast_to(np.arange(height, dtype=np.int32)[:, None], (height, width))

    # Paint smaller disparities first so nearer, larger-disparity pixels win conflicts.
    depth_order = np.argsort(np.abs(shift.reshape(-1)))
    valid_order = valid.reshape(-1)[depth_order]
    flat_y = target_y.reshape(-1)[depth_order][valid_order]
    flat_x = target_x.reshape(-1)[depth_order][valid_order]
    flat_source = frame.reshape((-1, 3))[depth_order][valid_order]

    output = frame.copy()
    written = np.zeros((height, width), dtype=np.uint8)
    output[flat_y, flat_x] = flat_source
    written[flat_y, flat_x] = 1
    mask = (1 - written) * 255
    if mask.any():
        output = cv2.inpaint(output, mask, max(1, int(inpaint_radius)), cv2.INPAINT_TELEA)
    return output


def repair_vertical_edge_bars(frame, max_fraction=0.025):
    import cv2

    height, width = frame.shape[:2]
    max_scan = max(2, min(24, int(round(width * float(max_fraction)))))
    gray = frame.mean(axis=2)

    def edge_bar_width(edge):
        count = 0
        for offset in range(max_scan):
            col = gray[:, offset] if edge == "left" else gray[:, width - 1 - offset]
            if float(col.mean()) <= 3.0 and float(np.percentile(col, 95)) <= 8.0:
                count += 1
            else:
                break
        return count

    left = edge_bar_width("left")
    right = edge_bar_width("right")
    if left < 2 and right < 2:
        return frame

    mask = np.zeros((height, width), dtype=np.uint8)
    if left >= 2:
        mask[:, : min(width, left + 1)] = 255
    if right >= 2:
        mask[:, max(0, width - right - 1) :] = 255
    return cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)


def make_stereo_inpaint(frame, depth, layout, depth_percent, invert_depth=False, inpaint_radius=3):
    import cv2

    frame = repair_vertical_edge_bars(frame)
    height, width = frame.shape[:2]
    depth_map = normalize_depth(depth)
    if invert_depth:
        depth_map = 1.0 - depth_map
    max_shift = max(1.0, width * (float(depth_percent) / 100.0))
    disparity = (depth_map - 0.5) * max_shift
    left = forward_warp_view(frame, disparity * 0.5, -1.0, inpaint_radius)
    right = forward_warp_view(frame, disparity * 0.5, 1.0, inpaint_radius)
    if layout == "full-sbs":
        return np.concatenate([left, right], axis=1)
    half_width = even(width / 2)
    left_half = cv2.resize(left, (half_width, height), interpolation=cv2.INTER_AREA)
    right_half = cv2.resize(right, (half_width, height), interpolation=cv2.INTER_AREA)
    return np.concatenate([left_half, right_half], axis=1)


def synthesize_stereo(frame, depth, args):
    if args.stereo_fill == "inpaint":
        return make_stereo_inpaint(frame, depth, args.layout, args.depth_percent, args.invert_depth, args.inpaint_radius)
    return make_stereo_remap(frame, depth, args.layout, args.depth_percent, args.invert_depth)


def build_depth_estimator(args):
    if args.processor == "coreml-depth-anything-v2-small":
        return CoreMLDepthAnything(args.model_path)
    if args.processor in DA3_PROCESSORS:
        return DepthAnything3Estimator(depth_model_id(args))
    return TorchDepthAnything(depth_model_id(args))


def depth_model_id(args):
    if args.model:
        return args.model
    if args.processor == "depth-anything-v3-small":
        return DA3_SMALL_MODEL
    if args.processor == "depth-anything-v3-base":
        return DA3_BASE_MODEL
    if args.processor == "depth-anything-v2-base":
        return PYTORCH_BASE_MODEL
    if args.processor == "depth-anything-v2-small":
        return PYTORCH_SMALL_MODEL
    if args.processor == "coreml-depth-anything-v2-small":
        return str(args.model_path)
    return ""


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

    if args.realtime_temporal:
        frames = decode_video_frames(args.input, args.start, args.duration, width, height, fps)
        if not frames:
            raise RuntimeError("No frames were decoded from the requested segment.")
        depths = predict_realtime_depths(
            estimator,
            frames,
            args.inference_scale,
            args.inference_crop_percent,
            args.da3_process_res_method,
            args.da3_ref_view_strategy,
            args.temporal_smoothing,
            args.temporal_window_frames,
            args.temporal_overlap_frames,
            args.depth_frame_stride,
        )
        encode_stereo_segment(args, frames, depths, args.output, args.start, args.duration, width, height, fps)
        return

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
            stereo = synthesize_stereo(frame, depth, args)
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


def decode_video_frames(input_url, start, duration, width, height, fps):
    frame_size = width * height * 3
    decoder = subprocess.Popen(
        [
            media_tool("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{float(start):.3f}",
            "-i",
            input_url,
            "-t",
            f"{float(duration):.3f}",
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
    frames = []
    assert decoder.stdout is not None
    while True:
        raw = read_exact(decoder.stdout, frame_size)
        if not raw:
            break
        frames.append(np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)).copy())
    stderr = decoder.stderr.read().decode("utf-8", "replace") if decoder.stderr else ""
    decoder.wait()
    if decoder.returncode:
        raise RuntimeError(f"ffmpeg decode failed: {stderr.strip()}")
    return frames


def encode_stereo_segment(args, frames, depths, output_path, segment_start, segment_duration, width, height, fps):
    out_width = width * 2 if args.layout == "full-sbs" else width
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
            f"{float(segment_start):.3f}",
            "-i",
            args.input,
            "-t",
            f"{float(segment_duration):.3f}",
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
            output_path,
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert encoder.stdin is not None
    try:
        for frame, depth in zip(frames, depths):
            stereo = synthesize_stereo(frame, depth, args)
            encoder.stdin.write(stereo.astype(np.uint8).tobytes())
    finally:
        encoder.stdin.close()
    stderr = encoder.stderr.read().decode("utf-8", "replace") if encoder.stderr else ""
    encoder.wait()
    if encoder.returncode:
        raise RuntimeError(f"ffmpeg encode failed: {stderr.strip()}")


def segment_file_name(index):
    return f"segment-{int(index):06d}.ts"


def prebuild_hls(args):
    if not args.output_dir:
        raise RuntimeError("--output-dir is required for --prebuild-hls.")
    stream = ffprobe_json(args.input)
    width, height, fps = target_geometry(stream, args.max_width, args.fps, args.resolution_scale)
    duration = parse_rate("0", 0.0)
    probe_duration = None
    try:
        completed = run(
            [
                media_tool("ffprobe"),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                args.input,
            ]
        )
        probe_duration = float((json.loads(completed.stdout or "{}").get("format") or {}).get("duration") or 0)
    except Exception:
        probe_duration = 0
    duration = probe_duration
    if duration <= 0:
        raise RuntimeError("ffprobe did not report a finite duration for HLS prebuild.")
    segment_seconds = max(1, int(args.segment_seconds))
    total_segments = max(1, int(math.ceil(duration / segment_seconds)))
    first_segment = max(0, int(args.segment_start))
    requested_count = int(args.segment_count or 0)
    last_segment = min(total_segments, first_segment + requested_count) if requested_count > 0 else total_segments
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / ".prebuild-manifest.json"
    metadata = read_json(args.metadata, {}) if args.metadata else {}
    manifest = read_json(manifest_path, {}) or {}
    settings = {
        "processor": args.processor,
        "model": depth_model_id(args),
        "layout": args.layout,
        "depthPercent": args.depth_percent,
        "resolutionScale": str(args.resolution_scale),
        "inferenceScale": str(args.inference_scale),
        "inferenceCropPercent": str(args.inference_crop_percent),
        "stereoFill": args.stereo_fill,
        "inpaintRadius": args.inpaint_radius,
        "temporalWindowFrames": args.temporal_window_frames,
        "temporalOverlapFrames": args.temporal_overlap_frames,
        "temporalContextSegments": args.temporal_context_segments,
        "temporalSmoothing": args.temporal_smoothing,
        "segmentBatchCount": args.segment_batch_count,
        "refViewStrategy": args.da3_ref_view_strategy,
        "processResMethod": args.da3_process_res_method,
        "fps": fps,
        "width": width,
        "height": height,
        "segmentSeconds": segment_seconds,
        "segmentCount": total_segments,
    }
    if manifest.get("settings") and manifest.get("settings") != settings:
        raise RuntimeError("Existing HLS prebuild manifest settings do not match this request.")
    manifest = {
        **manifest,
        "version": 1,
        "kind": "hls-3d-prebuild",
        "status": "running",
        "input": args.input,
        "outputDir": str(output_dir),
        "settings": settings,
        "metadata": metadata,
        "updatedAt": int(time.time()),
        "completedSegments": manifest.get("completedSegments") or [],
    }
    atomic_write_json(manifest_path, manifest)
    estimator = build_depth_estimator(args)
    completed = set(int(value) for value in manifest.get("completedSegments") or [])
    context_seconds = max(0, int(args.temporal_context_segments)) * segment_seconds
    batch_count = max(1, int(args.segment_batch_count or 1))
    segment_index = first_segment
    while segment_index < last_segment:
        output_path = output_dir / segment_file_name(segment_index)
        if output_path.exists() and output_path.stat().st_size > 0:
            completed.add(segment_index)
            segment_index += 1
            continue
        batch_start = segment_index
        batch_end = min(last_segment, batch_start + batch_count)
        segment_start = batch_start * segment_seconds
        batch_duration = max(0.1, min(batch_end * segment_seconds, duration) - segment_start)
        window_start = max(0.0, segment_start - context_seconds)
        window_end = min(duration, segment_start + batch_duration + context_seconds)
        window_duration = max(0.1, window_end - window_start)
        frames = decode_video_frames(args.input, window_start, window_duration, width, height, fps)
        if not frames:
            raise RuntimeError(f"No frames decoded for HLS segments {batch_start}-{batch_end - 1}.")
        depths = predict_depth_sequence_windowed(
            estimator,
            frames,
            args.inference_scale,
            args.inference_crop_percent,
            args.da3_process_res_method,
            args.da3_ref_view_strategy,
            args.temporal_smoothing,
            args.temporal_window_frames,
            args.temporal_overlap_frames,
        )
        for target_segment in range(batch_start, batch_end):
            output_path = output_dir / segment_file_name(target_segment)
            if output_path.exists() and output_path.stat().st_size > 0:
                completed.add(target_segment)
                continue
            target_start = target_segment * segment_seconds
            target_duration = max(0.1, min(segment_seconds, duration - target_start))
            target_frames = []
            target_depths = []
            for frame_index, (frame, depth) in enumerate(zip(frames, depths)):
                timestamp = window_start + (frame_index / fps)
                if target_start - (0.5 / fps) <= timestamp < target_start + target_duration - (0.01 / fps):
                    target_frames.append(frame)
                    target_depths.append(depth)
            if not target_frames:
                target_frames = frames[:1]
                target_depths = depths[:1]
            temp_path = output_path.with_name(f"{output_path.stem}.{os.getpid()}.part{output_path.suffix}")
            if temp_path.exists():
                temp_path.unlink()
            encode_stereo_segment(args, target_frames, target_depths, str(temp_path), target_start, target_duration, width, height, fps)
            temp_path.replace(output_path)
            completed.add(target_segment)
            manifest["completedSegments"] = sorted(completed)
            manifest["updatedAt"] = int(time.time())
            atomic_write_json(manifest_path, manifest)
        segment_index = batch_end
    manifest["status"] = "complete" if len(completed) >= total_segments else "partial"
    manifest["completedSegments"] = sorted(completed)
    manifest["updatedAt"] = int(time.time())
    atomic_write_json(manifest_path, manifest)


def parse_args():
    parser = argparse.ArgumentParser(description="Create SBS HLS segment with Depth Anything.")
    parser.add_argument("--processor", choices=["depth-anything-v2-small", "depth-anything-v2-base", "depth-anything-v3-small", "depth-anything-v3-base", "coreml-depth-anything-v2-small"], required=True)
    parser.add_argument("--input", help="Input URL or file path.")
    parser.add_argument("--output", help="Output MPEG-TS segment path.")
    parser.add_argument("--output-dir", help="Output HLS cache directory when --prebuild-hls is used.")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float, default=4.0)
    parser.add_argument("--segment-seconds", type=int, default=int(os.environ.get("FILE_PIPE_HLS_SEGMENT_SECONDS", "6")))
    parser.add_argument("--segment-start", type=int, default=0)
    parser.add_argument("--segment-count", type=int, default=0)
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
    parser.add_argument("--stereo-fill", choices=["inpaint", "remap"], default=os.environ.get("FILE_PIPE_DEPTH_STEREO_FILL", "inpaint"))
    parser.add_argument("--inpaint-radius", type=int, default=int(os.environ.get("FILE_PIPE_DEPTH_INPAINT_RADIUS", "3")))
    parser.add_argument("--realtime-temporal", action="store_true", help="Buffer this realtime segment and apply lightweight temporal smoothing before encoding.")
    parser.add_argument("--depth-frame-stride", type=int, default=int(os.environ.get("FILE_PIPE_DEPTH_FRAME_STRIDE", "1")), help="Infer depth on every Nth frame in realtime mode, then interpolate depth for skipped frames.")
    parser.add_argument("--temporal-window-frames", type=int, default=int(os.environ.get("FILE_PIPE_DA3_TEMPORAL_WINDOW_FRAMES", "2")))
    parser.add_argument("--temporal-overlap-frames", type=int, default=int(os.environ.get("FILE_PIPE_DA3_TEMPORAL_OVERLAP_FRAMES", "1")))
    parser.add_argument("--temporal-context-segments", type=int, default=int(os.environ.get("FILE_PIPE_DA3_TEMPORAL_CONTEXT_SEGMENTS", "1")))
    parser.add_argument("--temporal-smoothing", type=float, default=float(os.environ.get("FILE_PIPE_DA3_TEMPORAL_SMOOTHING", "0.18")))
    parser.add_argument("--segment-batch-count", type=int, default=int(os.environ.get("FILE_PIPE_DEPTH_PREBUILD_SEGMENT_BATCH_COUNT", "2")))
    parser.add_argument("--da3-process-res-method", default=os.environ.get("FILE_PIPE_DA3_PROCESS_RES_METHOD", "upper_bound_resize"))
    parser.add_argument("--da3-ref-view-strategy", default=os.environ.get("FILE_PIPE_DA3_REF_VIEW_STRATEGY", "saddle_balanced"))
    parser.add_argument("--metadata", default="", help="Optional JSON metadata file copied into the prebuild manifest.")
    parser.add_argument("--prebuild-hls", action="store_true", help="Build/resume an HLS 3D cache with temporal DA3 context.")
    parser.add_argument("--warmup", action="store_true", help="Load the model and run one tiny prediction, then exit.")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.warmup:
        warmup(args)
        return 0
    if args.prebuild_hls:
        prebuild_hls(args)
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
