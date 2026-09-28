const lightbox = document.querySelector('#guide-lightbox');
const lightboxContent = document.querySelector('#guide-lightbox-content');
const lightboxTitle = document.querySelector('#guide-lightbox-title');

if (lightbox && lightboxContent && lightboxTitle && typeof lightbox.showModal === 'function') {
  document.querySelectorAll('a.guide-shot[href^="guide-assets/"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const frame = document.createElement('div');
      frame.className = `${link.className} guide-shot--zoomed`;
      for (const child of link.childNodes) frame.append(child.cloneNode(true));
      lightboxContent.replaceChildren(frame);
      lightboxTitle.textContent = link.closest('figure')?.querySelector('figcaption')?.textContent?.trim()
        || link.closest('article')?.querySelector('h3')?.textContent?.trim()
        || '操作截图';
      lightbox.showModal();
    });
  });
  document.querySelector('#guide-lightbox-close').addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
}
