import { DefaultIssueManagerControllerService } from "./internal/issueManagerControllerService.ts";
import type { IssueManagerControllerService } from "./issueManagerControllerService.interface.ts";

export function createIssueManagerControllerService(): IssueManagerControllerService {
  return new DefaultIssueManagerControllerService();
}
