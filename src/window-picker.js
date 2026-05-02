const grid = document.getElementById('grid');
const cancelBtn = document.getElementById('cancel');

window.pico.onWindowSources((sources) => {
  grid.innerHTML = '';
  sources.forEach((source) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<div class="title"></div><img alt="thumbnail">`;
    card.querySelector('.title').textContent = source.name || 'Untitled Window';
    card.querySelector('img').src = source.thumbnail;
    card.addEventListener('click', () => window.pico.selectWindowSource(source.id));
    grid.appendChild(card);
  });
});

cancelBtn.addEventListener('click', () => window.pico.cancelWindowSource());
