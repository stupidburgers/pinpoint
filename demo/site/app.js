// Lumen demo: two tiny behaviours so the page is not dead. No network calls.
(function () {
  var fav = document.getElementById('fav-btn');
  if (fav) {
    fav.addEventListener('click', function () {
      fav.setAttribute('aria-pressed', fav.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
  }
  var menu = document.getElementById('menu-btn');
  var nav = document.querySelector('.nav');
  if (menu && nav) {
    menu.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === '1';
      nav.setAttribute('data-open', open ? '0' : '1');
      nav.style.display = open ? '' : 'flex';
    });
  }
})();
