export function createStableMasonry(container, { scrollContainer = window } = {}) {
  if (!(container instanceof HTMLElement)) throw new Error("瀑布流容器无效");
  const cards = [];
  let frame = 0;
  let destroyed = false;

  const schedule = () => {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  };
  const cardObserver = new ResizeObserver(schedule);
  const containerObserver = new ResizeObserver(schedule);
  containerObserver.observe(container);
  if (scrollContainer !== window) scrollContainer.addEventListener("resize", schedule);

  function layout() {
    if (destroyed || !container.clientWidth) return;
    const styles = getComputedStyle(container);
    const gap = positiveNumber(styles.getPropertyValue("--masonry-gap"), 8);
    const minimumWidth = positiveNumber(styles.getPropertyValue("--masonry-card-min-width"), 270);
    const columns = Math.max(1, Math.floor((container.clientWidth + gap) / (minimumWidth + gap)));
    const width = (container.clientWidth - gap * (columns - 1)) / columns;
    const heights = Array(columns).fill(0);
    for (const card of cards) {
      if (!card.isConnected) continue;
      card.style.width = `${width}px`;
      const column = heights.indexOf(Math.min(...heights));
      card.style.left = `${column * (width + gap)}px`;
      card.style.top = `${heights[column]}px`;
      heights[column] += card.getBoundingClientRect().height + gap;
    }
    container.style.height = `${Math.max(0, ...heights) - gap}px`;
  }

  function append(nextCards) {
    for (const card of nextCards) {
      if (cards.includes(card)) continue;
      cards.push(card);
      cardObserver.observe(card);
    }
    if (container.clientWidth) layout();
    else schedule();
  }

  function destroy() {
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    cardObserver.disconnect();
    containerObserver.disconnect();
    if (scrollContainer !== window) scrollContainer.removeEventListener("resize", schedule);
  }

  return { append, destroy };
}

function positiveNumber(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
