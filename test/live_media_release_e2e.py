from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


def main() -> None:
    media_url = os.environ.get("CURATED_MEDIA_URL", "").strip()
    if not media_url.startswith("https://github.com/"):
        raise RuntimeError("CURATED_MEDIA_URL 必须是公开 GitHub Release 视频地址")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_content("<video controls muted playsinline preload='metadata'></video>")
        result = page.evaluate(
            """async (url) => {
              const video = document.querySelector('video');
              const wait = (event) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), 20000);
                video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, {once: true});
                video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`视频错误 ${video.error?.code || 0}`)); }, {once: true});
              });
              const metadata = wait('loadedmetadata');
              video.src = url;
              video.load();
              await metadata;
              const duration = video.duration;
              const seeked = wait('seeked');
              video.currentTime = Math.min(1, duration / 2);
              await seeked;
              await video.play();
              await new Promise((resolve) => setTimeout(resolve, 400));
              const currentTime = video.currentTime;
              video.pause();
              video.removeAttribute('src');
              video.load();
              return {duration, currentTime, readyState: video.readyState};
            }""",
            media_url,
        )
        assert result["duration"] > 0, result
        assert result["currentTime"] > 0, result
        browser.close()
        print({"anonymous_playback": True, "range_seek": True, **result})


if __name__ == "__main__":
    main()
