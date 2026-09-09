"""Exercise every published package and the honest rights label at download time."""
import json
import os
from pathlib import Path
from urllib.parse import quote
from playwright.sync_api import expect, sync_playwright

SITE_URL = os.environ.get('CURATED_SITE_URL', 'http://127.0.0.1:4180').rstrip('/')
CATALOG = json.loads((Path(__file__).parents[1] / 'site/public-catalog.json').read_text())

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        results = []
        for theme in CATALOG['themes']:
            page.goto(SITE_URL + '/?pack=' + quote(theme['id']), wait_until='domcontentloaded')
            expect(page.locator('.detail-info h1')).to_have_text(theme['title'])
            expect(page.locator('.detail-actions a')).to_have_attribute('href', theme['downloadUrl'])
            expect(page.locator('.case-card').first).to_be_visible(timeout=20000)
            rights = '授权未核验' if theme['rightsStatus'] == 'source_unverified' else 'PromptDirector 原创'
            expect(page.locator('.detail-meta')).to_contain_text(rights)
            page.locator('.case-card').first.click()
            expect(page.locator('.case-detail-prompt')).to_be_visible()
            expect(page.locator('.case-detail-source')).to_contain_text(rights)
            if theme['rightsStatus'] == 'source_unverified':
                expect(page.locator('.case-detail-source a')).to_have_attribute('href', __import__('re').compile(r'^https://'))
            page.keyboard.press('Escape')
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            expect(page.locator('.detail-meta')).to_contain_text(rights)
            results.append({'id': theme['id'], 'cases': theme['caseCount'], 'rights': rights})
            page.set_viewport_size({'width': 1280, 'height': 900})
        assert not errors, errors
        browser.close()
        print(json.dumps({'packages_verified': results, 'total_cases': sum(t['caseCount'] for t in CATALOG['themes']), 'page_errors': errors}, ensure_ascii=False))

if __name__ == '__main__':
    main()
