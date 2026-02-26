const map = new maplibregl.Map({
  container: 'map',
  style: './style.json',
  center: [-117.16, 32.71],
  zoom: 10
});

map.addControl(new maplibregl.NavigationControl());