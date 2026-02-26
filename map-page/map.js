const map = new maplibregl.Map({
  container: 'map',
  style: './style.json',
  center: [-122.4, 37.77], // change to your desired location
  zoom: 10
});

map.addControl(new maplibregl.NavigationControl());