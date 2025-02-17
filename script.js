const messageEl = document.getElementById("message");
const btn = document.getElementById("btn");

btn.addEventListener("click", () => {
    const messages = [
        "JavaScript is awesome!",
        "Hello from script.js!",
        "Git + GitHub is great for version control.",
        "Coding is fun!",
        "Enjoy your day!"
    ];
    const msg = messages[Math.floor(Math.random() * messages.length)];
    messageEl.textContent = msg;
});
