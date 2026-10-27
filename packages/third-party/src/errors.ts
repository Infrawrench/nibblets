/**
 * An error whose message is safe to show the person: no credentials. Any
 * other error is logged by Connect and shown as the third party not
 * answering.
 */
export class ThirdPartyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThirdPartyError";
  }
}

/** The third party no longer takes the credential: Connect marks it revoked. */
export class ThirdPartyRevokedError extends ThirdPartyError {
  constructor(message: string) {
    super(message);
    this.name = "ThirdPartyRevokedError";
  }
}
