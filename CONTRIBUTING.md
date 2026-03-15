# Contributing to Forge

Welcome, and thank you for your interest in contributing to Forge!

Forge is an AI-native code editor built as a fork of VS Code. There are several ways in which you can contribute, beyond writing code. The goal of this document is to provide a high-level overview of how you can get involved.

## Asking Questions

Have a question? Instead of opening an issue, please start a [discussion](https://github.com/malwarebo/forge/discussions) on GitHub.

Your well-worded question will serve as a resource to others searching for help.

## Reporting Issues

Have you identified a reproducible problem in Forge? Do you have a feature request? We want to hear about it! Here's how you can report your issue as effectively as possible.

### Look For an Existing Issue

Before you create a new issue, please do a search in [open issues](https://github.com/malwarebo/forge/issues) to see if the issue or feature request has already been filed.

If you find your issue already exists, make relevant comments and add your [reaction](https://github.com/blog/2119-add-reactions-to-pull-requests-issues-and-comments). Use a reaction in place of a "+1" comment:

* 👍 - upvote
* 👎 - downvote

If you cannot find an existing issue that describes your bug or feature, create a new issue using the guidelines below.

### Writing Good Bug Reports and Feature Requests

File a single issue per problem and feature request. Do not enumerate multiple bugs or feature requests in the same issue.

The more information you can provide, the more likely someone will be successful at reproducing the issue and finding a fix.

Please include the following with each issue:

* Version of Forge
* Your operating system
* List of extensions that you have installed
* Reproducible steps (1... 2... 3...) that cause the issue
* What you expected to see, versus what you actually saw
* Images, animations, or a link to a video showing the issue occurring
* A code snippet that demonstrates the issue or a link to a code repository the developers can easily pull down to recreate the issue locally
* Errors from the Dev Tools Console (open from the menu: Help > Toggle Developer Tools)

### Final Checklist

Please remember to do the following:

* [ ] Search the issue repository to ensure your report is a new issue
* [ ] Recreate the issue after disabling all extensions
* [ ] Simplify your code around the issue to better isolate the problem

## Contributing Code

If you are interested in writing code to fix issues or add features:

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the project's coding conventions
4. Ensure the project compiles without errors
5. Submit a pull request

### Development Setup

```bash
git clone https://github.com/malwarebo/forge.git
cd forge
npm install
npm run watch
./scripts/code.sh
```

### Coding Guidelines

- Use tabs, not spaces
- PascalCase for types and enum values
- camelCase for functions, methods, properties, local variables
- All Forge-specific code goes in `src/forge/`
- Follow existing patterns in the codebase

## License

By contributing to Forge, you agree that your contributions will be licensed under the [MIT License](LICENSE.txt).

## Thank You

Your contributions to open source, large or small, make great projects like this possible. Thank you for taking the time to contribute.
