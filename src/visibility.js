// Per-role visibility. A viewer is the role the current request runs as.
// Rules only ever remove content; nothing here grants access to more than the boxes define.
import { globMatcher, labelMatcher, isMarkdown, fileExtension } from './util.js';
import { DEFAULT_PUBLIC_EXTENSIONS } from './config.js';

export function createViewer(config, roleName) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}"`);
  const hiddenPath = globMatcher(role.hide.paths);
  const hiddenLabel = labelMatcher(role.hide.issueLabels);
  // The config supplies a list (default ["all"] when the key is omitted). Anything else sees nothing.
  const audiences = Array.isArray(role.audiences) ? role.audiences : [];
  const publicExtensions = new Set(config.docs?.publicExtensions ?? DEFAULT_PUBLIC_EXTENSIONS);
  const canSeeAudience = (value) => typeof value === 'string' && value.length > 0 && audiences.includes(value);
  return {
    role: role.name,
    policy: role.policy,
    audiences,
    canSeeAudience,
    // Markdown uses its audience value. Any other file is shown when its extension is public,
    // or when the viewer's audiences include owner.
    canSeeFile(p, audience) {
      if (isMarkdown(p)) return canSeeAudience(audience);
      const ext = fileExtension(p);
      return Boolean(ext && publicExtensions.has(ext)) || audiences.includes('owner');
    },
    canSeeBox(box) {
      if (role.hide.boxes.includes(box.id)) return false;
      return !box.visibleTo.length || box.visibleTo.includes(role.name);
    },
    canSeePath(p) {
      return !hiddenPath(p);
    },
    canSeeIssue(issue) {
      if (issue.labels.some((l) => hiddenLabel(l))) return false;
      return !role.hide.issueTitlePatterns.some((re) => re.test(issue.title));
    },
  };
}
