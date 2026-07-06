/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0c0f", 900: "#0f1216", 850: "#14181d", 800: "#1a1f26", 700: "#252c35" },
        line: "#2a323c",
        amber: { DEFAULT: "#f5a623", soft: "#f7b955" },
        lime: "#c6f24e",
      },
      fontFamily: {
        sans: ["Manrope Variable", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["Space Grotesk Variable", "Manrope Variable", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 30px -12px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [],
};
