// Theme toggle
const root = document.documentElement;
document.querySelector(".theme-toggle")!.addEventListener("click", () => {
    const isDark =
        root.dataset.theme === "dark" ||
        (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = isDark ? "light" : "dark";
    try {
        localStorage.setItem("theme", root.dataset.theme);
    } catch (e) {}
});

// Mobile menu
const toggle = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const setMenu = (open: boolean): void => {
    document.body.classList.toggle("menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
};
toggle.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
document.querySelectorAll(".sidebar a").forEach((a) => a.addEventListener("click", () => setMenu(false)));

// Scrollspy: highlight the current section in the sidebar
const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
const links = new Map(
    [...document.querySelectorAll<HTMLAnchorElement>(".sidebar a")].map((a) => [a.getAttribute("href")!.slice(1), a])
);
const headings = [...document.querySelectorAll<HTMLElement>(".content h1[id], .content h2[id]")].filter((h) =>
    links.has(h.id)
);
let active: HTMLAnchorElement | undefined;

const updateActive = (): void => {
    const offset = 90;
    let currentHeading = headings[0];
    for (const h of headings) {
        if (h.getBoundingClientRect().top - offset <= 0) currentHeading = h;
        else break;
    }
    const link = links.get(currentHeading.id)!;
    if (link === active) return;
    active?.classList.remove("active");
    document.querySelectorAll(".toc-chapter.current").forEach((c) => c.classList.remove("current"));
    link.classList.add("active");
    link.closest(".toc-chapter")!.classList.add("current");
    active = link;
    // keep the active link visible in the sidebar, without scrolling the page
    const linkBox = link.getBoundingClientRect();
    const sidebarBox = sidebar.getBoundingClientRect();
    if (linkBox.top < sidebarBox.top + 40 || linkBox.bottom > sidebarBox.bottom - 40) {
        sidebar.scrollTop += linkBox.top - sidebarBox.top - sidebarBox.height / 3;
    }
};

let ticking = false;
window.addEventListener(
    "scroll",
    () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            updateActive();
            ticking = false;
        });
    },
    { passive: true }
);
updateActive();
