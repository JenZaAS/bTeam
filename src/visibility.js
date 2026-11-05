// Per-role visibility. A viewer is the role the current request runs as.
// Rules only ever remove content; nothing here grants access to more than the boxes define.
import { globMatcher, labelMatcher } from './util.js';

export function createViewer(config, roleName) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}"`);
  const hiddenPath = globMatcher(role.hide.paths);
  const hiddenLabel = labelMatcher(role.hide.issueLabels);
  // The config supplies a list (default ["all"] when the key is omitted). Anything else sees nothing.
  const audiences = Array.isArray(role.audiences) ? role.audiences : [];
  return {
    role: role.name,
    policy: role.policy,
    audiences,
    canSeeAudience(value) {
      return typeof value === 'string' && value.length > 0 && audiences.includes(value);
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
