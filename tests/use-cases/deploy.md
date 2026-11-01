# Use case: putting a finished project online

Lee's habit tracker is merged and running locally. Lee types `/deploy`.

1. Claude reads the project: a Tauri app with a Postgres database, a private
   GitHub repo, and a green `main`.
2. It recommends Fly.io for the app because there's a database, and also offers
   desktop installers on GitHub Releases. Lee wants `app.habits.example` for the
   app. Pages on a private repo needs a paid plan and Lee is on the free plan, so
   Claude recommends publishing the splash page from a separate public repo,
   and Lee agrees.
3. Claude prints the plan: the files it will add, the site repo it will create,
   the secrets Lee must set, the DNS records and the final URLs. Nothing goes
   live until Lee picks "Go ahead".
4. The splash page is designed the way `/ux-mockup` works: Impeccable shapes a
   landing page from `VISION.md`, builds it as one self-contained page with
   screenshots from the mockup, then hardens, polishes and scores it. Claude
   serves it locally, and Lee asks for one copy change before approving it.
5. Claude adds the Pages workflow and the Fly.io workflow from pinned templates,
   checking each action's latest major first. For the Fly token it gives Lee
   `! gh secret set FLY_API_TOKEN` to run; the token never appears in the chat.
6. The push triggers both workflows. Claude watches them, fixes a failing build
   step in the repo rather than deploying by hand, and checks that both URLs
   answer. The custom domain's certificate is still pending, so it says what to
   check later, and it records the URLs against the project.
