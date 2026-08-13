from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


SITE_URL = os.environ.get("CURATED_SITE_URL", "http://127.0.0.1:4180")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(SITE_URL, wait_until="networkidle")

        expect(page.locator(".pack-card")).to_have_count(9)
        expect(page.locator("#sort-downloads")).to_be_enabled()
        expect(page.locator(".topbar h1")).to_have_text("精选案例")
        expect(page.locator("#filter-popover")).to_be_hidden()
        screenshot_dir = os.environ.get("CURATED_SCREENSHOT_DIR")
        if screenshot_dir:
            target = Path(screenshot_dir)
            target.mkdir(parents=True, exist_ok=True)
            page.locator("#sort-menu summary").click()
            expect(page.locator("#sort-menu")).to_have_attribute("open", "")
            expect(page.locator("#filter-popover")).to_be_hidden()
            expect(page.locator(".sort-panel button")).to_have_count(3)
            page.screenshot(path=target / "curated-public-wall.png", full_page=False)
            page.locator("#sort-menu summary").click()

        page.locator(".pack-card").first.click()
        expect(page.locator(".detail-info > *")).to_have_count(3)
        expect(page.locator(".detail-actions")).to_contain_text("下载包")
        expect(page.locator(".detail-actions")).to_contain_text("关注")
        expect(page.locator(".detail-actions")).to_contain_text("复制链接")
        expect(page.locator(".case-card")).to_have_count(20)
        expect(page.locator("text=版本")).to_have_count(0)
        expect(page.locator("text=更新")).to_have_count(0)
        expect(page.locator("text=更多")).to_have_count(0)
        expect(page.locator("text=保存")).to_have_count(0)
        expect(page.locator(".detail-prompt, pre")).to_have_count(0)
        assert "github.com/wchao6891/PromptDirector-Curated/releases/download" in page.locator(".detail-actions a").get_attribute("href")
        if screenshot_dir:
            page.screenshot(path=target / "curated-public-detail.png", full_page=False)

        page.locator(".follow-action").click()
        expect(page.locator(".follow-action")).to_have_text("已关注")
        page.keyboard.press("Escape")
        expect(page.locator("#detail-dialog")).not_to_be_visible()
        expect(page.locator(".pack-card").first).to_be_focused()

        page.goto(f"{SITE_URL}?pack=featured%3Avol-1", wait_until="networkidle")
        expect(page.locator("#detail-dialog")).to_be_visible()
        expect(page.locator(".detail-info h1")).to_have_text("Vol.1 原创国风视觉")
        page.locator("#detail-close").click()

        page.locator("#search-input").fill("1970s Mediterranean 16mm Documentary")
        expect(page.locator(".pack-card")).to_have_count(1, timeout=10_000)
        expect(page.locator(".pack-card h2")).to_contain_text("EvoLink")
        page.locator("#search-input").fill("")

        page.locator("#filter-button").click()
        page.locator('input[value="video_prompt"]').check()
        expect(page.locator(".pack-card")).to_have_count(5)
        page.locator("#clear-filters").click()
        expect(page.locator(".pack-card")).to_have_count(9)

        page.set_viewport_size({"width": 820, "height": 650})
        page.locator(".pack-card").first.click()
        medium_geometry = page.evaluate(
            """() => ({viewport: innerWidth, page: document.documentElement.scrollWidth,
              info: document.querySelector('.detail-info').getBoundingClientRect().width})"""
        )
        assert medium_geometry["page"] <= medium_geometry["viewport"], medium_geometry
        assert 360 <= medium_geometry["info"] <= 450, medium_geometry
        page.keyboard.press("Escape")

        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".pack-card").nth(1).click()
        expect(page.locator(".case-card")).to_have_count(150)
        geometry = page.evaluate("""() => ({viewport: innerWidth, page: document.documentElement.scrollWidth})""")
        assert geometry["page"] <= geometry["viewport"], geometry
        if screenshot_dir:
            page.screenshot(path=Path(screenshot_dir) / "curated-public-mobile.png", full_page=False)
        assert not errors, errors
        browser.close()

        print({
            "packs": 9,
            "detail_layers": 3,
            "public_save_buttons": 0,
            "inner_case_search": True,
            "medium": medium_geometry,
            "mobile": geometry,
        })


if __name__ == "__main__":
    main()
