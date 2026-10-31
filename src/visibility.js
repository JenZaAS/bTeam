// Per-role visibility. A viewer is the role the current request runs as.
// Rules only ever remove content; nothing here grants access to more than the boxes define.
import { globMatcher, labelMatcher } from './util.js';

export function createViewer(config, roleName) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}"`);
  const hiddenPath = globMatcher(role.hide.paths);
  const hiddenLabel = labelMatcher(role.hide.issueLabels);
  return {
    role: role.name,
    policy: role.policy,
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
