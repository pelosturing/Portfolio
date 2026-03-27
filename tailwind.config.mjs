/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      keyframes: {
        scaleAnim: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.1)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        scale: 'scaleAnim 300ms ease-in-out',
      },
      typography: {
        invert: {
          css: {
            '--tw-prose-body': '#d4d4d4',
            '--tw-prose-headings': '#dfdfdf',
            '--tw-prose-links': '#a476ff',
            '--tw-prose-bold': '#dfdfdf',
            '--tw-prose-code': '#a476ff',
            '--tw-prose-pre-bg': '#1a1a1a',
            '--tw-prose-pre-code': '#d4d4d4',
            '--tw-prose-quotes': '#d4d4d4',
            '--tw-prose-quote-borders': '#a476ff',
            '--tw-prose-hr': '#ffffff10',
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
