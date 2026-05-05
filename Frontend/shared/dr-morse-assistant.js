(function () {
  const currentScript = document.currentScript;
  const scriptUrl = currentScript ? currentScript.src : window.location.href;
  const iconUrl = new URL("./dr-morse.png", scriptUrl).href;
  const stylesheetUrl = new URL("./dr-morse-assistant.css", scriptUrl).href;
  const routes = {
    search: new URL("../search-page/index.html", scriptUrl).href,
    map: new URL("../map-page/index.html", scriptUrl).href,
    play: new URL("../loading-page/index.html", scriptUrl).href,
    submit: new URL("../data-submission-page/index.html", scriptUrl).href,
    about: new URL("../about-page/index.html", scriptUrl).href
  };
  const facts = [
    "Seed beetle larvae usually develop inside a single seed, eating and growing where they hatch.",
    "Many seed beetles are specialists, using only a narrow set of host plants.",
    "Seed beetles belong to Bruchinae, a subfamily within the leaf beetle family Chrysomelidae.",
    "The exposed rear end of many seed beetles is called the pygidium, and it can help with identification.",
    "Some seed beetles are important agricultural pests because they can damage stored legumes.",
    "Host plant records are especially useful because they reveal how seed beetles interact with ecosystems."
  ];

  if (document.querySelector(".dr-morse-widget")) return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = stylesheetUrl;
  document.head.appendChild(link);

  const widget = document.createElement("aside");
  widget.className = "dr-morse-widget";
  widget.setAttribute("aria-label", "Dr. Morse assistant");
  widget.innerHTML = `
    <button class="dr-morse-launcher" type="button" aria-label="Open Dr. Morse assistant" aria-expanded="false">
      <img src="${iconUrl}" alt="" aria-hidden="true" />
    </button>
    <section class="dr-morse-panel hidden" aria-label="Dr. Morse chat">
      <header class="dr-morse-header">
        <img src="${iconUrl}" alt="" aria-hidden="true" />
        <div>
          <p class="dr-morse-title">Dr. Morse</p>
          <p class="dr-morse-subtitle">BruchinDB guide</p>
        </div>
        <button class="dr-morse-close" type="button" aria-label="Close Dr. Morse assistant">&times;</button>
      </header>
      <div class="dr-morse-messages" aria-live="polite"></div>
      <div class="dr-morse-actions" aria-label="Quick actions">
        <button class="dr-morse-chip" type="button" data-topic="search">Search</button>
        <button class="dr-morse-chip" type="button" data-topic="map">Map</button>
        <button class="dr-morse-chip" type="button" data-topic="play">Play</button>
        <button class="dr-morse-chip" type="button" data-topic="submit">Submit Data</button>
        <button class="dr-morse-chip" type="button" data-topic="about">About</button>
        <button class="dr-morse-chip" type="button" data-topic="fact">Fun Fact</button>
      </div>
      <form class="dr-morse-form">
        <input class="dr-morse-input" type="text" placeholder="Ask me where to go..." aria-label="Message Dr. Morse" />
        <button class="dr-morse-send" type="submit">Send</button>
      </form>
    </section>
  `;
  document.body.appendChild(widget);

  const launcher = widget.querySelector(".dr-morse-launcher");
  const panel = widget.querySelector(".dr-morse-panel");
  const closeButton = widget.querySelector(".dr-morse-close");
  const messages = widget.querySelector(".dr-morse-messages");
  const form = widget.querySelector(".dr-morse-form");
  const input = widget.querySelector(".dr-morse-input");

  function addMessage(text, sender) {
    const message = document.createElement("p");
    message.className = `dr-morse-message ${sender}`;
    message.textContent = text;
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
  }

  function randomFact() {
    return facts[Math.floor(Math.random() * facts.length)];
  }

  function responseFor(topic) {
    if (topic === "search") return "Use Search to find seed beetle taxa and specimen records. I can take you there now.";
    if (topic === "map") return "Use Map to explore specimen localities geographically and see where records occur.";
    if (topic === "play") return "Use Play for Beetle Runner, a quick seed beetle game with rotating facts.";
    if (topic === "submit") return "Use Submit Data to contribute photos, locality details, host plant notes, and collection information.";
    if (topic === "about") return "Use About to learn what BruchinDB is, who built the data, and why the project exists.";
    if (topic === "fact") return randomFact();
    return "I can help you choose where to go: Search, Map, Play, Submit Data, or About. I can also share seed beetle fun facts.";
  }

  function detectTopic(text) {
    const value = text.toLowerCase();
    if (value.includes("search") || value.includes("find") || value.includes("record")) return "search";
    if (value.includes("map") || value.includes("where") || value.includes("location")) return "map";
    if (value.includes("play") || value.includes("game")) return "play";
    if (value.includes("submit") || value.includes("upload") || value.includes("contribute")) return "submit";
    if (value.includes("about") || value.includes("bruchindb")) return "about";
    if (value.includes("fact") || value.includes("beetle") || value.includes("seed")) return "fact";
    return "help";
  }

  function openPanel() {
    panel.classList.remove("hidden");
    launcher.setAttribute("aria-expanded", "true");

    if (!messages.children.length) {
      addMessage(
        "Hi, I am Dr. Morse. I can help you navigate BruchinDB or share seed beetle fun facts. What would you like to do?",
        "assistant"
      );
    }

    input.focus();
  }

  function closePanel() {
    panel.classList.add("hidden");
    launcher.setAttribute("aria-expanded", "false");
  }

  function handleTopic(topic) {
    addMessage(responseFor(topic), "assistant");

    if (routes[topic]) {
      const goButton = document.createElement("button");
      goButton.className = "dr-morse-chip";
      goButton.type = "button";
      goButton.textContent = `Go to ${topic === "submit" ? "Submit Data" : topic.charAt(0).toUpperCase() + topic.slice(1)}`;
      goButton.addEventListener("click", () => {
        window.location.href = routes[topic];
      });
      messages.appendChild(goButton);
      messages.scrollTop = messages.scrollHeight;
    }
  }

  launcher.addEventListener("click", () => {
    if (panel.classList.contains("hidden")) {
      openPanel();
    } else {
      closePanel();
    }
  });

  closeButton.addEventListener("click", closePanel);

  widget.querySelectorAll("[data-topic]").forEach((button) => {
    button.addEventListener("click", () => {
      const topic = button.dataset.topic;
      addMessage(button.textContent, "user");
      handleTopic(topic);
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    input.value = "";
    handleTopic(detectTopic(text));
  });
})();
