(function () {
  const scriptUrl = new URL(document.currentScript.src);
  const siteRoot = new URL("../", scriptUrl);
  const iconUrl = new URL("./AI_assistant_pic.png", scriptUrl).href;
  const fallbackIconUrl = new URL("./dr-samenkafer.svg", scriptUrl).href;

  if (window.location.pathname.includes("/welcome-page/")) {
    return;
  }

  const pages = {
    search: {
      label: "Search",
      url: new URL("search-page/index.html", siteRoot).href,
      hint: "Search helps you explore seed beetle species and specimens by name, tribe, place, and host plant."
    },
    map: {
      label: "Map",
      url: new URL("map-page/index.html", siteRoot).href,
      hint: "Map shows specimen localities geographically, with filters for narrowing records."
    },
    play: {
      label: "Play",
      url: new URL("loading-page/index.html", siteRoot).href,
      hint: "Play opens Beetle Runner, a quick seed beetle game."
    },
    submit: {
      label: "Submit Data",
      url: new URL("data-submission-page/index.html", siteRoot).href,
      hint: "Submit Data is where contributors can send records, photos, locality notes, and host information."
    },
    about: {
      label: "About",
      url: new URL("about-page/index.html", siteRoot).href,
      hint: "About explains the purpose of BruchinDB and the research behind the database."
    }
  };

  const facts = [
    "Seed beetles are leaf beetles in the subfamily Bruchinae, and many species develop inside seeds.",
    "A seed beetle larva often completes its entire immature life inside one seed before emerging as an adult.",
    "Many seed beetles are host specialists, which makes them useful for studying plant-insect relationships.",
    "The pygidium, the exposed rear plate of many seed beetles, can be important for identification.",
    "Some seed beetles are major pests of stored legumes, while others are valuable clues in biodiversity research.",
    "Female seed beetles can use plant chemistry and seed traits to choose where to lay eggs.",
    "Seed beetles and legumes have a long evolutionary relationship shaped by seed defenses and insect adaptations."
  ];

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function addMessage(messages, text, sender) {
    const message = createElement("div", `samenkafer-message ${sender}`, text);
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
  }

  function getFact() {
    return facts[Math.floor(Math.random() * facts.length)];
  }

  function findPage(input) {
    const text = input.toLowerCase();
    if (text.includes("submit") || text.includes("data") || text.includes("contribute")) return pages.submit;
    if (text.includes("search") || text.includes("species") || text.includes("specimen")) return pages.search;
    if (text.includes("map") || text.includes("location") || text.includes("locality")) return pages.map;
    if (text.includes("play") || text.includes("game") || text.includes("runner")) return pages.play;
    if (text.includes("about") || text.includes("info") || text.includes("bruchindb")) return pages.about;
    return null;
  }

  function buildResponse(input) {
    const text = input.trim().toLowerCase();
    const page = findPage(text);

    if (!text) {
      return "Ask me where to go, or ask for a seed beetle fact.";
    }

    if (text.includes("fact") || text.includes("beetle") || text.includes("seed")) {
      return getFact();
    }

    if (text.includes("help") || text.includes("navigate") || text.includes("where")) {
      return "I can point you to Search, Map, Play, Submit Data, or About. I also know a few seed beetle facts.";
    }

    if (page) {
      return `${page.hint} Use the quick button below if you want me to take you there.`;
    }

    return "I can help with navigation around BruchinDB or share fun facts about seed beetles. Try asking for the map, search, submit data, or a fun fact.";
  }

  function initAssistant() {
    if (document.querySelector(".samenkafer-assistant")) return;

    const root = createElement("section", "samenkafer-assistant");
    root.setAttribute("aria-label", "Dr. Samenkäfer AI assistant");

    const toggle = createElement("button", "samenkafer-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Open Dr. Samenkäfer chat");
    toggle.setAttribute("aria-expanded", "false");
    const toggleImg = document.createElement("img");
    toggleImg.src = iconUrl;
    toggleImg.onerror = () => {
      toggleImg.onerror = null;
      toggleImg.src = fallbackIconUrl;
    };
    toggleImg.alt = "Dr. Samenkäfer";
    toggle.appendChild(toggleImg);

    const panel = createElement("div", "samenkafer-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with Dr. Samenkäfer");

    const header = createElement("div", "samenkafer-header");
    const headerAvatar = createElement("span", "samenkafer-header-avatar");
    headerAvatar.setAttribute("aria-hidden", "true");
    const headerImg = document.createElement("img");
    headerImg.src = iconUrl;
    headerImg.onerror = () => {
      headerImg.onerror = null;
      headerImg.src = fallbackIconUrl;
    };
    headerImg.alt = "";
    headerImg.setAttribute("aria-hidden", "true");
    headerAvatar.appendChild(headerImg);
    const heading = createElement("div");
    heading.appendChild(createElement("p", "samenkafer-title", "Dr. Samenkäfer"));
    heading.appendChild(createElement("p", "samenkafer-subtitle", "BruchinDB assistant"));
    const close = createElement("button", "samenkafer-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close chat");
    header.append(headerAvatar, heading, close);

    const messages = createElement("div", "samenkafer-messages");
    messages.setAttribute("aria-live", "polite");

    const quickActions = createElement("div", "samenkafer-quick-actions");
    Object.values(pages).forEach((page) => {
      const button = createElement("button", "samenkafer-chip", page.label);
      button.type = "button";
      button.addEventListener("click", () => {
        window.location.href = page.url;
      });
      quickActions.appendChild(button);
    });
    const factButton = createElement("button", "samenkafer-chip", "Fun Fact");
    factButton.type = "button";
    factButton.addEventListener("click", () => addMessage(messages, getFact(), "bot"));
    quickActions.appendChild(factButton);

    const form = createElement("form", "samenkafer-form");
    const input = createElement("input", "samenkafer-input");
    input.type = "text";
    input.placeholder = "Ask Dr. Samenkäfer...";
    input.setAttribute("aria-label", "Message Dr. Samenkäfer");
    const send = createElement("button", "samenkafer-send", "Send");
    send.type = "submit";
    form.append(input, send);

    panel.append(header, messages, quickActions, form);
    root.append(panel, toggle);
    document.body.appendChild(root);

    addMessage(messages, "Guten Tag! I’m Dr. Samenkäfer. I can help you find Search, Map, Play, Submit Data, About, or share seed beetle facts.", "bot");

    function setOpen(isOpen) {
      root.classList.toggle("is-open", isOpen);
      toggle.setAttribute("aria-expanded", String(isOpen));
      toggle.setAttribute("aria-label", isOpen ? "Close Dr. Samenkäfer chat" : "Open Dr. Samenkäfer chat");
      if (isOpen) window.setTimeout(() => input.focus(), 120);
    }

    toggle.addEventListener("click", () => setOpen(!root.classList.contains("is-open")));
    close.addEventListener("click", () => setOpen(false));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      addMessage(messages, value, "user");
      input.value = "";
      const page = findPage(value);
      const shouldNavigate = /\b(go|open|take|visit|show|send)\b/i.test(value);
      window.setTimeout(() => {
        addMessage(messages, buildResponse(value), "bot");
        if (page && shouldNavigate) {
          window.setTimeout(() => {
            window.location.href = page.url;
          }, 650);
        }
      }, 180);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAssistant);
  } else {
    initAssistant();
  }
})();
