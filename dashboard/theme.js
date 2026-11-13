(() => {
  const key = "cex-dashboard-theme";
  const initial = localStorage.getItem(key) || "dark";
  document.documentElement.dataset.theme = initial === "light" ? "light" : "dark";
  const update = () => {
    for (const button of document.querySelectorAll(".theme-toggle")) {
      button.textContent = document.documentElement.dataset.theme === "dark" ? "Light mode" : "Dark mode";
    }
  };
  update();
  for (const button of document.querySelectorAll(".theme-toggle")) {
    button.addEventListener("click", () => {
      const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
      localStorage.setItem(key, theme);
      update();
    });
  }
})();
