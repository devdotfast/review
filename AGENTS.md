## Testing

Do not add [Change Detector Tests](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html). If you come across one, instead of updating it as part of a change, delete it. Check with the author if it should be replaced, do not assume it should be.

## Planning documents

Do not automatically stage or commit planning documents, implementation checklists,
or Superpowers plans and specs. Creating or updating a plan does not authorize
adding it to Git. Include these files only when the user explicitly asks to commit
them or include them in a PR. Use explicit file paths when staging changes to avoid
accidentally including local planning documents.
