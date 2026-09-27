// A file imported as its text (Vite's ?raw): the search worker's source, evaluated in a worker thread.
declare module '*?raw' {
  const source: string
  export default source
}
