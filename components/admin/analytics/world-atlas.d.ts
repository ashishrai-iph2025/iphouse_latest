// Natural Earth topology from `world-atlas`, imported by WorldBubbleMap. Vite
// loads the JSON; declared here so TypeScript accepts the import without
// switching on resolveJsonModule for the whole project.
declare module 'world-atlas/countries-110m.json' {
  const topology: any
  export default topology
}
