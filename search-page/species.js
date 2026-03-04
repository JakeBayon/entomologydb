// Simple tab switcher
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;

    // update buttons
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");

    // update panels
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.remove("is-active");
    });
    document.getElementById(target).classList.add("is-active");
  });
});