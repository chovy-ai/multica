import type {
  CreateIssueManagerControllerSessionInput,
  IssueManagerControllerService,
  IssueManagerControllerSession
} from "../issueManagerControllerService.interface.ts";
import { createIssueManagerControllerRuntime } from "./controllerRuntime.ts";

export class DefaultIssueManagerControllerService implements IssueManagerControllerService {
  createSession(
    input: CreateIssueManagerControllerSessionInput
  ): IssueManagerControllerSession {
    return createIssueManagerControllerRuntime(input);
  }
}
