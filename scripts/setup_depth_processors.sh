#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
SKIP_INSTALL=0
SKIP_MODEL_DOWNLOAD=0
PROCESSORS=("depth-anything-v2-small" "depth-anything-v2-base" "coreml-depth-anything-v2-small")

if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_HOME="$HOME/Library/Application Support/File Pipe/depth-processors"
else
  DEFAULT_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/file-pipe/depth-processors"
fi
DEPTH_HOME="${FILE_PIPE_DEPTH_PROCESSOR_HOME:-$DEFAULT_HOME}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      DEPTH_HOME="$2"
      shift 2
      ;;
    --python)
      PYTHON_BIN="$2"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-model-download)
      SKIP_MODEL_DOWNLOAD=1
      shift
      ;;
    --processor)
      PROCESSORS=("$2")
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: scripts/setup_depth_processors.sh [options]

Options:
  --home PATH              Install helper and venv here.
  --python PATH            Python executable used to create the venv.
  --processor ID           Warm up one processor instead of the default small + base + Core ML.
  --skip-install           Copy helper but do not install Python dependencies.
  --skip-model-download    Do not pre-download/warm up models.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$DEPTH_HOME"
cp "$ROOT_DIR/scripts/depth_anything_stereo.py" "$DEPTH_HOME/depth_anything_stereo.py"
chmod +x "$DEPTH_HOME/depth_anything_stereo.py"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  "$PYTHON_BIN" -m venv "$DEPTH_HOME/.venv"
  "$DEPTH_HOME/.venv/bin/python" -m pip install --upgrade pip wheel setuptools
  "$DEPTH_HOME/.venv/bin/python" -m pip install -r "$ROOT_DIR/requirements-depth.txt"
fi

if [[ "$SKIP_MODEL_DOWNLOAD" -eq 0 ]]; then
  for processor in "${PROCESSORS[@]}"; do
    "$DEPTH_HOME/.venv/bin/python" "$DEPTH_HOME/depth_anything_stereo.py" --processor "$processor" --warmup
  done
fi

cat <<EOF

Depth processors installed in:
  $DEPTH_HOME

The Local connector auto-discovers this helper. To force a processor for all 3D
HLS requests, start the connector with one of:

  FILE_PIPE_HLS_STEREO3D_PROCESSOR=depth-anything-v2-small
  FILE_PIPE_HLS_STEREO3D_PREBUILD_PROCESSOR=depth-anything-v2-base
  FILE_PIPE_HLS_STEREO3D_PROCESSOR=coreml-depth-anything-v2-small

Manual command templates, if needed:

  FILE_PIPE_DEPTH_ANYTHING_V2_SMALL_COMMAND='$DEPTH_HOME/.venv/bin/python' '$DEPTH_HOME/depth_anything_stereo.py' --processor depth-anything-v2-small --input {input} --output {output} --start {start} --duration {duration} --layout {layout} --video-profile {video_profile} --depth-percent {depth_percent} --resolution-scale {resolution_scale} --inference-scale {inference_scale} --inference-crop-percent {inference_crop_percent}

  FILE_PIPE_DEPTH_ANYTHING_V2_BASE_COMMAND='$DEPTH_HOME/.venv/bin/python' '$DEPTH_HOME/depth_anything_stereo.py' --processor depth-anything-v2-base --input {input} --output {output} --start {start} --duration {duration} --layout {layout} --video-profile {video_profile} --depth-percent {depth_percent} --resolution-scale {resolution_scale} --inference-scale {inference_scale} --inference-crop-percent {inference_crop_percent}

  FILE_PIPE_COREML_DEPTH_ANYTHING_V2_SMALL_COMMAND='$DEPTH_HOME/.venv/bin/python' '$DEPTH_HOME/depth_anything_stereo.py' --processor coreml-depth-anything-v2-small --input {input} --output {output} --start {start} --duration {duration} --layout {layout} --video-profile {video_profile} --depth-percent {depth_percent} --resolution-scale {resolution_scale} --inference-scale {inference_scale} --inference-crop-percent {inference_crop_percent}
EOF
