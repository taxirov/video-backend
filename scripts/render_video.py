import argparse
from pathlib import Path
from moviepy_pipeline import render_video

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images-dir", required=True)
    ap.add_argument("--audio-path", required=True)
    ap.add_argument("--output-path", required=True)
    ap.add_argument("--captions-path", required=False, default=None)
    ap.add_argument("--assets-dir", required=False, default="")
    args = ap.parse_args()

    captions = args.captions_path
    if captions and not Path(captions).exists():
        captions = None

    render_video(
        images_dir=args.images_dir,
        audio_path=args.audio_path,
        captions_path=captions,
        output_path=args.output_path,
        assets_dir=args.assets_dir
    )

if __name__ == "__main__":
    main()
