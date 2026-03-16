const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const revealItems = document.querySelectorAll("[data-reveal]");

if (!prefersReducedMotion && revealItems.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.2,
      rootMargin: "0px 0px -40px 0px",
    }
  );

  revealItems.forEach((item, index) => {
    item.style.setProperty("--reveal-delay", `${Math.min(index * 60, 240)}ms`);
    observer.observe(item);
  });
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

const heroStage = document.getElementById("hero-stage");
const heroEmblem = document.getElementById("hero-emblem");
const contactForm = document.getElementById("contact-form");
const contactStatus = document.getElementById("contact-form-status");
const submittedAtField = document.getElementById("contact-form-submitted-at");

if (heroStage && !prefersReducedMotion) {
  const state = {
    targetX: 0,
    targetY: 0,
    currentX: 0,
    currentY: 0,
    frame: 0,
  };

  const render = (time) => {
    state.currentX += (state.targetX - state.currentX) * 0.08;
    state.currentY += (state.targetY - state.currentY) * 0.08;
    const idleX = Math.sin(time / 2800) * 0.9;
    const idleY = Math.cos(time / 3400) * 1.2;
    const stageX = state.currentX + idleX;
    const stageY = state.currentY + idleY;

    heroStage.style.transform = `rotateX(${stageX}deg) rotateY(${stageY}deg)`;

    if (heroEmblem) {
      heroEmblem.style.filter =
        `drop-shadow(${stageY * 0.3}px ${34 + stageX * -0.45}px 58px rgba(0, 0, 0, 0.56)) ` +
        `drop-shadow(0 0 ${29 + Math.abs(stageY)}px rgba(240, 204, 133, 0.22))`;
    }

    state.frame = requestAnimationFrame(render);
  };

  const resetTransform = () => {
    state.targetX = 0;
    state.targetY = 0;
  };

  heroStage.addEventListener("pointermove", (event) => {
    const rect = heroStage.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    state.targetY = (px - 0.5) * 7;
    state.targetX = (0.5 - py) * 7;
  });

  heroStage.addEventListener("pointerleave", resetTransform);
  heroStage.addEventListener("pointercancel", resetTransform);
  state.frame = requestAnimationFrame(render);
}

if (contactForm && contactStatus) {
  const submitButton = contactForm.querySelector(".contact-form__submit");
  const defaultButtonLabel = submitButton ? submitButton.textContent : "";
  const emailField = contactForm.querySelector('input[name="email"]');
  let isSubmitting = false;
  let lastSubmitAt = 0;

  const setStatus = (message, tone) => {
    contactStatus.textContent = message;
    contactStatus.classList.remove("is-success", "is-error");

    if (tone) {
      contactStatus.classList.add(tone);
    }

    contactStatus.classList.toggle("is-visible", Boolean(message));
  };

  const resetSubmittedAt = () => {
    if (submittedAtField) {
      submittedAtField.value = String(Date.now());
    }
  };

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (emailField) {
    emailField.addEventListener("input", () => {
      emailField.setCustomValidity("");
    });
  }

  resetSubmittedAt();

  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    if (Date.now() - lastSubmitAt < 2500) {
      setStatus("Please wait a moment before submitting again.", "is-error");
      return;
    }

    if (emailField && !emailPattern.test(emailField.value.trim())) {
      emailField.setCustomValidity("Enter a valid email address.");
    }

    if (!contactForm.reportValidity()) {
      return;
    }

    const formData = new FormData(contactForm);
    const payload = {
      name: formData.get("name"),
      email: formData.get("email"),
      company: formData.get("company"),
      message: formData.get("message"),
      website: formData.get("website"),
      submittedAt: formData.get("submittedAt"),
    };

    isSubmitting = true;
    lastSubmitAt = Date.now();
    setStatus("Sending your request...", "");
    contactForm.classList.remove("is-success");
    contactForm.classList.add("is-loading");

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending...";
    }

    fetch("/api/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || "Unable to send your request right now.");
        }

        contactForm.classList.remove("is-loading");
        contactForm.classList.remove("is-success");
        void contactForm.offsetWidth;
        contactForm.classList.add("is-success");
        setStatus("Request delivered. PRP will follow up with next steps.", "is-success");
        contactForm.reset();
        resetSubmittedAt();
      })
      .catch((error) => {
        contactForm.classList.remove("is-loading");
        setStatus(error.message || "Something went wrong. Please try again.", "is-error");
      })
      .finally(() => {
        isSubmitting = false;

        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = defaultButtonLabel;
        }
      });
  });
}

// Update the contact links and asset filename here if branding details change.
