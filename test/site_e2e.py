from __future__ import annotations

import json
import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


SITE_URL = os.environ.get("CURATED_SITE_URL", "http://127.0.0.1:4180")
CATALOG = json.loads((Path(__file__).parents[1] / "site" / "catalog.json").read_text())
EXPECTED_PACK_COUNT = len(CATALOG["themes"])
EXPECTED_VIDEO_PACK_COUNT = sum(theme["type"] == "video_prompt" for theme in CATALOG["themes"])


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.grant_permissions(["clipboard-read", "clipboard-write"], origin=SITE_URL)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(SITE_URL, wait_until="networkidle")

        expect(page.locator(".pack-card")).to_have_count(EXPECTED_PACK_COUNT)
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
        expect(page.locator(".case-card h3, .case-footer, .case-copy-action")).to_have_count(0)
        expect(page.locator("text=版本")).to_have_count(0)
        expect(page.locator("text=更新")).to_have_count(0)
        expect(page.locator("text=更多")).to_have_count(0)
        expect(page.locator("text=保存")).to_have_count(0)
        expect(page.locator(".detail-prompt, .case-detail-prompt")).to_have_count(0)
        assert "github.com/wchao6891/PromptDirector-Curated/releases/download" in page.locator(".detail-actions a").get_attribute("href")
        page.locator(".case-card").first.click()
        expect(page.locator("#case-detail-drawer")).to_have_class("case-detail-drawer open")
        expect(page.locator(".case-detail-prompt")).to_be_visible()
        expect(page.locator(".case-detail-actions button")).to_have_count(1)
        expect(page.locator("text=保存到案例库")).to_have_count(0)
        page.locator(".case-detail-actions button").click()
        expect(page.locator(".case-detail-actions button")).to_have_text("已复制")
        page.keyboard.press("Escape")
        expect(page.locator("#case-detail-drawer")).not_to_have_class("case-detail-drawer open")
        expect(page.locator(".case-card").first).to_be_focused()
        if screenshot_dir:
            page.screenshot(path=target / "curated-public-detail.png", full_page=False)

        before_follow = page.evaluate("""() => {
          document.querySelector('.case-card').dataset.renderIdentity = 'kept';
          document.querySelector('#detail-dialog').scrollTop = 120;
          return document.querySelector('#detail-dialog').scrollTop;
        }""")
        page.locator(".follow-action").click()
        expect(page.locator(".follow-action")).to_have_text("已关注")
        assert page.locator('.case-card[data-render-identity="kept"]').count() == 1
        assert page.locator("#detail-dialog").evaluate("dialog => dialog.scrollTop") == before_follow
        page.keyboard.press("Escape")
        expect(page.locator("#detail-dialog")).not_to_be_visible()
        expect(page.locator(".pack-card").first).to_be_focused()

        page.goto(f"{SITE_URL}?pack=featured%3Ajimeng", wait_until="networkidle")
        expect(page.locator(".case-card")).to_have_count(24)
        page.locator(".case-card").nth(2).click()
        expect(page.locator(".case-detail-heading h2")).to_have_text("即梦 · @啊福")
        assert page.locator("#detail-content").get_attribute("inert") == ""
        assert page.locator("#detail-close").get_attribute("inert") == ""
        portrait_geometry = page.locator(".case-detail-figure img").evaluate(
            "img => ({naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, renderedWidth: img.getBoundingClientRect().width, renderedHeight: img.getBoundingClientRect().height})"
        )
        assert portrait_geometry["naturalWidth"] == 900, portrait_geometry
        assert portrait_geometry["naturalHeight"] == 1600, portrait_geometry
        assert abs(
            portrait_geometry["renderedWidth"] / portrait_geometry["renderedHeight"] - 900 / 1600
        ) < 0.01, portrait_geometry
        page.keyboard.press("Escape")
        expect(page.locator(".case-card").nth(2)).to_be_focused()
        page.keyboard.press("Escape")

        page.goto(f"{SITE_URL}?pack=featured%3Ajimeng-guofeng-community-1", wait_until="networkidle")
        expect(page.locator(".detail-info h1")).to_have_text("即梦国风投稿精选 · 第 1 期")
        expect(page.locator(".case-card")).to_have_count(24)
        page.locator(".case-card").first.click()
        expect(page.locator(".case-detail-heading h2")).to_have_text("即梦 · @用户San川cg")
        expect(page.locator(".case-detail-heading p")).to_have_text("@用户San川cg")
        expect(page.locator(".case-detail-source")).to_contain_text("归原作者或其他权利人")
        expect(page.locator(".case-detail-source a")).to_have_attribute("href", re.compile(r"^https://jimeng\.jianying\.com/ai-tool/work-detail/"))
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")

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
        expect(page.locator(".pack-card")).to_have_count(EXPECTED_VIDEO_PACK_COUNT)
        page.locator("#clear-filters").click()
        expect(page.locator(".pack-card")).to_have_count(EXPECTED_PACK_COUNT)

        page.locator(".pack-card").nth(7).click()
        expect(page.locator(".case-card")).to_have_count(24)
        expect(page.locator(".case-video-badge")).to_have_count(24)
        page.locator(".case-card").first.hover()
        expect(page.locator(".case-card").first.locator(".case-video-preview")).to_have_count(1)
        page.locator(".case-card").first.click()
        expect(page.locator(".case-detail-video")).to_have_count(1)
        page.keyboard.press("Escape")
        case_geometry = page.locator(".case-card").evaluate_all(
            "cards => cards.map(card => ({width: card.offsetWidth, height: card.offsetHeight, top: card.offsetTop}))"
        )
        assert case_geometry[0]["height"] < case_geometry[10]["height"], case_geometry
        assert case_geometry[1]["top"] == case_geometry[0]["top"], case_geometry[:4]
        page.keyboard.press("Escape")

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
        expect(page.locator(".case-card")).to_have_count(24)
        geometry = page.evaluate("""() => ({viewport: innerWidth, page: document.documentElement.scrollWidth})""")
        assert geometry["page"] <= geometry["viewport"], geometry
        if screenshot_dir:
            page.screenshot(path=Path(screenshot_dir) / "curated-public-mobile.png", full_page=False)
        assert not errors, errors

        failure_page = context.new_page()
        catalog_attempts = {"count": 0}

        def fail_catalog_once(route) -> None:
            catalog_attempts["count"] += 1
            if catalog_attempts["count"] == 1:
                route.fulfill(status=503, content_type="text/plain", body="temporary failure")
            else:
                route.continue_()

        failure_page.route(f"{SITE_URL}/catalog.json", fail_catalog_once)
        failure_page.goto(SITE_URL, wait_until="domcontentloaded")
        expect(failure_page.locator(".empty-state")).to_contain_text("精选目录加载失败")
        expect(failure_page.locator(".empty-state button")).to_have_text("重试")
        failure_page.locator(".empty-state button").click()
        expect(failure_page.locator(".pack-card")).to_have_count(EXPECTED_PACK_COUNT)
        failure_page.close()
        browser.close()

        print({
            "packs": EXPECTED_PACK_COUNT,
            "detail_layers": 3,
            "public_save_buttons": 0,
            "masonry_natural_heights": True,
            "real_portrait_ratio": portrait_geometry,
            "inner_case_search": True,
            "medium": medium_geometry,
            "mobile": geometry,
            "catalog_retry": catalog_attempts["count"],
        })


if __name__ == "__main__":
    main()
