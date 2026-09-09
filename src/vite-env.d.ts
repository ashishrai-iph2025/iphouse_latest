/// <reference types="vite/client" />

// Vite's ambient types, which the project had been doing without.
//
// Added when the report gained a chart-engine picker: the Toast UI adapter
// imports that library's stylesheet through a dynamic `import()`, and without
// this reference TypeScript has no declaration for a `.css` module and reports
// the import as a missing package. Vite has handled such imports since the
// project was ported to it; only the type declaration was absent.
