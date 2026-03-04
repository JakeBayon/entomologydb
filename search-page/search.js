function toggleSection(element) {
  const content = element.nextElementSibling;
  const arrow = element.querySelector(".arrow");

  content.classList.toggle("open");
  arrow.classList.toggle("rotate");
}
