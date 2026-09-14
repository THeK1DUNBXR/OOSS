Prisma reads every `.prisma` file in this directory as one schema. `main.prisma`
holds the generator, the datasource and every model that predates the
compliance work; each `compliance-*.prisma` file holds the models one compliance
workstream owns, so the workstreams can be built side by side without editing
one another's files. A field added to a pre-existing model still goes in
`main.prisma`, because a model cannot be split across files.
