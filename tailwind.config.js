/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#07111f",
        panel: "#0f1a2a",
        mist: "#e7edf6",
        snap: "#17c4d8",
        moss: "#35c789",
        ember: "#f06a4d",
      },
      boxShadow: {
        frame: "0 18px 80px rgba(3, 7, 18, 0.28)",
      },
    },
  },
  plugins: [],
}
