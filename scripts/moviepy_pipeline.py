# -*- coding: utf-8 -*-
import math
import os
import tempfile
from glob import glob

from typing import Optional

from moviepy import (
    ImageClip, AudioFileClip, AudioClip, CompositeVideoClip, ColorClip,
    concatenate_videoclips, concatenate_audioclips, TextClip
)
from moviepy.video.tools.subtitles import SubtitlesClip
from moviepy.video.fx.FadeIn import FadeIn
from moviepy.video.fx.FadeOut import FadeOut


def render_video(
    images_dir: str,
    audio_path: str,
    output_path: str,
    captions_path: Optional[str] = None,
    assets_dir: str = "",
):
    # =========================
    # Sozlamalar (siznikidan)
    # =========================
    FPS = 20
    TARGET_W, TARGET_H = 720, 1280

    MODE = "trim_to_audio"  # {"trim_to_audio", "pad_audio"}
    TRANSITION = 0.6
    EPSILON = 0.10

    # Assets
    background_path = os.path.join(assets_dir, "background.png") if assets_dir else ""
    font_path = os.path.join(assets_dir, "fonts", "Poppins-Medium.ttf") if assets_dir else ""
    if font_path and not os.path.exists(font_path):
        font_path = ""

    BACKGROUND_COLOR = (255, 255, 255)

    CONTENT_SCALE = 0.86
    BORDER_PX = 16
    BORDER_COLOR = (240, 240, 240)

    # subtitles UI
    SUB_FONT_SIZE = 44
    SUB_PAD_X, SUB_PAD_Y = 36, 18
    SUB_BOX_OPACITY = 0.55
    SUB_STROKE_WIDTH = 4
    SUB_SHADOW_OFFSET = (3, 3)
    SUB_SHADOW_ALPHA = 0.35
    SUB_BOTTOM_MARGIN = 160

    def downscale_images(image_paths, max_w, max_h, tmpdir):
        try:
            from PIL import Image, ImageOps
        except Exception:
            return image_paths

        if max_w <= 0 or max_h <= 0:
            return image_paths

        resized = []
        for idx, src in enumerate(image_paths):
            try:
                with Image.open(src) as im:
                    im = ImageOps.exif_transpose(im)
                    im.thumbnail((max_w, max_h), Image.LANCZOS)
                    im = im.convert("RGB")
                    dst = os.path.join(tmpdir, f"{idx:03d}.jpg")
                    im.save(dst, format="JPEG", quality=85, optimize=True)
                    resized.append(dst)
                    continue
            except Exception:
                pass
            resized.append(src)
        return resized

    # =========================
    # Yordamchi funksiyalar
    # =========================
    def make_background(duration: float):
        if background_path and os.path.exists(background_path):
            bg = ImageClip(background_path).resized((TARGET_W, TARGET_H)).with_duration(duration)
        else:
            bg = ColorClip(size=(TARGET_W, TARGET_H), color=BACKGROUND_COLOR).with_duration(duration)
        return bg

    def framed_image_clip(img_path: str, duration: float) -> ImageClip:
        w_box = int(TARGET_W * CONTENT_SCALE)
        inner_w = max(1, w_box - 2 * BORDER_PX)

        img = ImageClip(img_path).with_duration(duration).resized(width=inner_w)
        h_box = img.h + 2 * BORDER_PX

        frame = ColorClip(size=(w_box, h_box), color=BORDER_COLOR).with_duration(duration)

        framed = CompositeVideoClip(
            [frame, img.with_position(("center", "center"))],
            size=(w_box, h_box)
        ).with_duration(duration)

        return framed.with_effects([FadeIn(TRANSITION), FadeOut(TRANSITION)])

    def make_subtitle_txt(text, *_, **__):
        padded_text = (text or "").rstrip() + "\n "

        txt = TextClip(
            text=padded_text,
            font=font_path if font_path else None,
            font_size=SUB_FONT_SIZE,
            color="white",
            method="caption",
            size=(int(TARGET_W * 0.90), None),
            text_align="center",
            stroke_color="black",
            stroke_width=SUB_STROKE_WIDTH,
            transparent=True
        )

        shadow = TextClip(
            text=padded_text,
            font=font_path if font_path else None,
            font_size=SUB_FONT_SIZE,
            color="black",
            method="caption",
            size=(int(TARGET_W * 0.90), None),
            text_align="center",
            transparent=True
        ).with_opacity(SUB_SHADOW_ALPHA)

        box_w = txt.w + 2 * SUB_PAD_X
        box_h = txt.h + 2 * SUB_PAD_Y

        panel = ColorClip(size=(box_w, box_h), color=(0, 0, 0)).with_opacity(SUB_BOX_OPACITY)

        return CompositeVideoClip(
            [
                panel,
                shadow.with_position((SUB_PAD_X + SUB_SHADOW_OFFSET[0],
                                      SUB_PAD_Y + SUB_SHADOW_OFFSET[1])),
                txt.with_position((SUB_PAD_X, SUB_PAD_Y))
            ],
            size=(box_w, box_h)
        )

    MAX_IMAGES = int(os.getenv("MAX_IMAGES", "10"))

    # =========================
    # Ma'lumotlarni tayyorlash
    # =========================
    images = sorted(
        glob(os.path.join(images_dir, "*.*")),
        key=lambda p: os.path.basename(p).lower()
    )
    if not images:
        raise FileNotFoundError(f"'{images_dir}' papkasida rasm topilmadi.")
    if len(images) > MAX_IMAGES:
        images = images[:MAX_IMAGES]

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio topilmadi: {audio_path}")

    inner_w = int(TARGET_W * CONTENT_SCALE) - 2 * BORDER_PX
    inner_h = int(TARGET_H * CONTENT_SCALE) - 2 * BORDER_PX

    with tempfile.TemporaryDirectory(prefix="video-images-") as tmpdir:
        images = downscale_images(images, inner_w, inner_h, tmpdir)

        audio = None
        audio_duration = 0.0
        try:
            audio = AudioFileClip(audio_path)
            audio_duration = float(audio.duration or 0.0)
        except Exception:
            audio = None
            audio_duration = 0.0

        n = len(images)
        if not math.isfinite(audio_duration):
            audio_duration = 0.0

        if audio_duration > 0.01:
            base = audio_duration / n
            per_slide = max(base + EPSILON, TRANSITION + 0.2)
        else:
            per_slide = max(2.5, TRANSITION + 0.2)
        durations = [per_slide] * n
        total_duration = sum(durations)

        if audio_duration <= 0.01:
            # Fallback to slideshow duration when audio metadata is empty.
            audio_duration = total_duration
            MODE = "pad_audio"
            if audio:
                try:
                    audio.close()
                except Exception:
                    pass
                audio = None

        # =========================
        # Slaydlarni yig'ish
        # =========================
        slides = []
        for img_path, d in zip(images, durations):
            framed = framed_image_clip(img_path, duration=d)
            bg = make_background(duration=d)

            slide = CompositeVideoClip(
                [bg, framed.with_position(("center", "center"))],
                size=(TARGET_W, TARGET_H)
            ).with_duration(d)

            slides.append(slide)

        slideshow = concatenate_videoclips(slides, method="compose", padding=-TRANSITION)

        # =========================
        # Audio bilan birlashtirish
        # =========================
        if audio:
            if MODE == "trim_to_audio":
                final = slideshow.with_audio(audio).with_duration(audio_duration)
            elif MODE == "pad_audio":
                total = total_duration
                if total > audio_duration:
                    sil = total - audio_duration
                    silence = AudioClip(lambda t: [0], duration=sil, fps=44100)
                    full_audio = concatenate_audioclips([audio, silence])
                    final = slideshow.with_audio(full_audio).with_duration(total)
                else:
                    final = slideshow.with_audio(audio).with_duration(audio_duration)
            else:
                raise ValueError("MODE noto'g'ri. 'trim_to_audio' yoki 'pad_audio' bo'lishi kerak.")
        else:
            final = slideshow.with_duration(total_duration)

        # =========================
        # Subtitrlarni qo'shish
        # =========================
        if captions_path and os.path.exists(captions_path) and os.getenv("SKIP_CAPTIONS") != "1":
            try:
                subs = SubtitlesClip(
                    captions_path,
                    make_textclip=make_subtitle_txt,
                    encoding="utf-8-sig"
                )

                probe = make_subtitle_txt("gypqj\n ")
                panel_h = probe.h
                try:
                    probe.close()
                except Exception:
                    pass

                subs = subs.with_position(("center", TARGET_H - SUB_BOTTOM_MARGIN - panel_h))
                final = CompositeVideoClip([final, subs], size=(TARGET_W, TARGET_H)).with_duration(final.duration)
            except Exception:
                pass

        # =========================
        # Saqlash
        # =========================
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        final.write_videofile(
            output_path,
            fps=FPS,
            codec="libx264",
            audio_codec="aac",
            audio=bool(audio),
            preset="fast",
            threads=2
        )
