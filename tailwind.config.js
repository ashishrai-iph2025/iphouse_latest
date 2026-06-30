/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      boxShadow: {
        'lg2':   '0 4px 32px 0 rgba(20,37,74,0.10)',
        'card':  '0 2px 8px 0 rgba(20,37,74,0.07)',
      },
      colors: {
        'brand-muted': '#6B7C93',
      },
    },
  },
  plugins: [],
}
