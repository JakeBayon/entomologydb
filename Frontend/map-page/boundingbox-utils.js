// Small helper for the bounding-box feature.
// (separated into its own file to make it easier to test without needing the whole map UI)
// using Jest testing framework (for JavaScript)

export function polygonFromCorners(a, b) {
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);
  const south = Math.min(a.lat, b.lat);
  const north = Math.max(a.lat, b.lat);

  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}
