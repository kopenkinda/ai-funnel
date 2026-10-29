export default {
  meta: { name: "project" },
  rules: {
    "no-em-dash": {
      meta: {
        type: "suggestion",
        docs: { description: "Forbid em dashes in source text and comments." },
        schema: [],
        messages: {
          forbidden: "Do not use em dashes. Rewrite with a comma or a period.",
        },
      },
      create(context) {
        const source = context.sourceCode;
        return {
          Program() {
            for (const match of source.text.matchAll(/\u2014/gu)) {
              context.report({
                loc: {
                  start: source.getLocFromIndex(match.index),
                  end: source.getLocFromIndex(match.index + 1),
                },
                messageId: "forbidden",
              });
            }
          },
        };
      },
    },
  },
};
