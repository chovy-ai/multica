export function pickComposerFiles(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.dataset.testid = "multica-composer-file-input";
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    document.body.append(input);
    try { input.click(); }
    catch (error) { input.remove(); reject(error); }
  });
}
