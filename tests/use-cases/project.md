# Use case: remembering where the projects live

Lee keeps projects in two folders, one for work and one for side projects.

1. Lee types `/project` for the first time. Nothing is remembered yet, so Claude
   asks where Lee keeps projects and remembers the answer as the default folder.
2. `/project add-root ~/side --create` makes and remembers the second folder.
   `/project roots` lists both, with the default marked.
3. `/project scan` finds three git repos under those folders that aren't
   registered, and Lee registers two of them.
4. `/new-project` registers each project it creates and records its stage as it
   goes. `/project` lists every project with its stage, kind and GitHub repo,
   and flags one whose folder was moved away.
5. A week later Lee opens a session inside a project that stopped after the
   mockup. The session-start hook says which stage it is at and suggests
   `/new-project resume <name>`. Sessions in unregistered folders, or in
   finished projects, hear nothing.
6. Lee forgets an old project. Its files stay exactly where they were.
7. When Claude shows Lee a mockup or a splash page, it serves the folder with a
   small local server that picks a free port, never serves files outside that
   folder, and never caches, so a reload always shows the latest edit.
