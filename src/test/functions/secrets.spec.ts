import * as sinon from "sinon";
import { expect } from "chai";

import * as secretManager from "../../gcp/secretManager";
import * as secrets from "../../functions/secrets";
import * as utils from "../../utils";
import * as prompt from "../../prompt";
import * as backend from "../../deploy/functions/backend";
import { Options } from "../../options";
import { FirebaseError } from "../../error";

describe("functions/secret", () => {
  const options = { force: false } as Options;

  describe("ensureValidKey", () => {
    let warnStub: sinon.SinonStub;
    let promptStub: sinon.SinonStub;

    beforeEach(() => {
      warnStub = sinon.stub(utils, "logWarning").resolves(undefined);
      promptStub = sinon.stub(prompt, "promptOnce").resolves(true);
    });

    afterEach(() => {
      warnStub.restore();
      promptStub.restore();
    });

    it("returns the original key if it follows convention", async () => {
      expect(await secrets.ensureValidKey("MY_SECRET_KEY", options)).to.equal("MY_SECRET_KEY");
      expect(warnStub).to.not.have.been.called;
    });

    it("returns the transformed key (with warning) if with dashes", async () => {
      expect(await secrets.ensureValidKey("MY-SECRET-KEY", options)).to.equal("MY_SECRET_KEY");
      expect(warnStub).to.have.been.calledOnce;
    });

    it("returns the transformed key (with warning) if with periods", async () => {
      expect(await secrets.ensureValidKey("MY.SECRET.KEY", options)).to.equal("MY_SECRET_KEY");
      expect(warnStub).to.have.been.calledOnce;
    });

    it("returns the transformed key (with warning) if with lower cases", async () => {
      expect(await secrets.ensureValidKey("my_secret_key", options)).to.equal("MY_SECRET_KEY");
      expect(warnStub).to.have.been.calledOnce;
    });

    it("returns the transformed key (with warning) if camelCased", async () => {
      expect(await secrets.ensureValidKey("mySecretKey", options)).to.equal("MY_SECRET_KEY");
      expect(warnStub).to.have.been.calledOnce;
    });

    it("throws error if given non-conventional key w/ forced option", () => {
      expect(secrets.ensureValidKey("throwError", { ...options, force: true })).to.be.rejectedWith(
        FirebaseError
      );
    });

    it("throws error if given reserved key", () => {
      expect(secrets.ensureValidKey("FIREBASE_CONFIG", options)).to.be.rejectedWith(FirebaseError);
    });
  });

  describe("ensureSecret", () => {
    const secret: secretManager.Secret = {
      projectId: "project-id",
      name: "MY_SECRET",
      labels: secrets.labels(),
    };

    let sandbox: sinon.SinonSandbox;
    let getStub: sinon.SinonStub;
    let createStub: sinon.SinonStub;
    let patchStub: sinon.SinonStub;
    let promptStub: sinon.SinonStub;
    let warnStub: sinon.SinonStub;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      getStub = sandbox.stub(secretManager, "getSecret").rejects("Unexpected call");
      createStub = sandbox.stub(secretManager, "createSecret").rejects("Unexpected call");
      patchStub = sandbox.stub(secretManager, "patchSecret").rejects("Unexpected call");

      promptStub = sandbox.stub(prompt, "promptOnce").resolves(true);
      warnStub = sandbox.stub(utils, "logWarning").resolves(undefined);
    });

    afterEach(() => {
      sandbox.verifyAndRestore();
    });

    it("returns existing secret if we have one", async () => {
      getStub.resolves(secret);

      await expect(
        secrets.ensureSecret("project-id", "MY_SECRET", options)
      ).to.eventually.deep.equal(secret);
      expect(getStub).to.have.been.calledOnce;
    });

    it("prompt user to have Firebase manage the secret if not managed by Firebase", async () => {
      getStub.resolves({ ...secret, labels: [] });
      patchStub.resolves(secret);

      await expect(
        secrets.ensureSecret("project-id", "MY_SECRET", options)
      ).to.eventually.deep.equal(secret);
      expect(warnStub).to.have.been.calledOnce;
      expect(promptStub).to.have.been.calledOnce;
    });

    it("creates a new secret if it doesn't exists", async () => {
      getStub.rejects({ status: 404 });
      createStub.resolves(secret);

      await expect(
        secrets.ensureSecret("project-id", "MY_SECRET", options)
      ).to.eventually.deep.equal(secret);
    });

    it("throws if it cannot reach Secret Manager", async () => {
      getStub.rejects({ status: 500 });

      await expect(secrets.ensureSecret("project-id", "MY_SECRET", options)).to.eventually.be
        .rejected;
    });
  });

  describe("of", () => {
    const ENDPOINT = {
      id: "id",
      region: "region",
      project: "project",
      entryPoint: "id",
      runtime: "nodejs16",
      platform: "gcfv1" as const,
      httpsTrigger: {},
    };

    function makeSecret(name: string, version?: string): backend.SecretEnvVar {
      return {
        projectId: "project",
        key: name,
        secret: name,
        version: version ?? "1",
      };
    }

    it("returns empty list given empty list", () => {
      expect(secrets.of([])).to.be.empty;
    });

    it("collects all secret environment variables", () => {
      const secret1 = makeSecret("SECRET1");
      const secret2 = makeSecret("SECRET2");
      const secret3 = makeSecret("SECRET3");

      const endpoints: backend.Endpoint[] = [
        {
          ...ENDPOINT,
          secretEnvironmentVariables: [secret1],
        },
        ENDPOINT,
        {
          ...ENDPOINT,
          secretEnvironmentVariables: [secret2, secret3],
        },
      ];
      expect(secrets.of(endpoints)).to.have.members([secret1, secret2, secret3]);
      expect(secrets.of(endpoints)).to.have.length(3);
    });
  });

  describe("pruneSecrets", () => {
    const ENDPOINT = {
      id: "id",
      region: "region",
      project: "project",
      entryPoint: "id",
      runtime: "nodejs16",
      platform: "gcfv1" as const,
      httpsTrigger: {},
    };

    let listSecretsStub: sinon.SinonStub;
    let listSecretVersionsStub: sinon.SinonStub;
    let getSecretVersionStub: sinon.SinonStub;

    const secret1: secretManager.Secret = {
      projectId: "project",
      name: "MY_SECRET1",
    };
    const secretVersion11: secretManager.SecretVersion = {
      secret: secret1,
      versionId: "1",
    };
    const secretVersion12: secretManager.SecretVersion = {
      secret: secret1,
      versionId: "2",
    };

    const secret2: secretManager.Secret = {
      projectId: "project",
      name: "MY_SECRET2",
    };
    const secretVersion21: secretManager.SecretVersion = {
      secret: secret2,
      versionId: "1",
    };

    function toSecretEnvVar(sv: secretManager.SecretVersion): backend.SecretEnvVar {
      return {
        projectId: "project",
        version: sv.versionId,
        secret: sv.secret.name,
        key: sv.secret.name,
      };
    }

    beforeEach(() => {
      listSecretsStub = sinon.stub(secretManager, "listSecrets").rejects("Unexpected call");
      listSecretVersionsStub = sinon
        .stub(secretManager, "listSecretVersions")
        .rejects("Unexpected call");
      getSecretVersionStub = sinon
        .stub(secretManager, "getSecretVersion")
        .rejects("Unexpected call");
    });

    afterEach(() => {
      listSecretsStub.restore();
      listSecretVersionsStub.restore();
      getSecretVersionStub.restore();
    });

    it("returns nothing if unused", async () => {
      listSecretsStub.resolves([]);

      await expect(
        secrets.pruneSecrets({ projectId: "project", projectNumber: "12345" }, [])
      ).to.eventually.deep.equal([]);
    });

    it("returns all secrets given no endpoints", async () => {
      listSecretsStub.resolves([secret1, secret2]);
      listSecretVersionsStub.onFirstCall().resolves([secretVersion11, secretVersion12]);
      listSecretVersionsStub.onSecondCall().resolves([secretVersion21]);

      const pruned = await secrets.pruneSecrets(
        { projectId: "project", projectNumber: "12345" },
        []
      );

      expect(pruned).to.have.deep.members(
        [secretVersion11, secretVersion12, secretVersion21].map(toSecretEnvVar)
      );
      expect(pruned).to.have.length(3);
    });

    it("does not include secret version in use", async () => {
      listSecretsStub.resolves([secret1, secret2]);
      listSecretVersionsStub.onFirstCall().resolves([secretVersion11, secretVersion12]);
      listSecretVersionsStub.onSecondCall().resolves([secretVersion21]);

      const pruned = await secrets.pruneSecrets({ projectId: "project", projectNumber: "12345" }, [
        { ...ENDPOINT, secretEnvironmentVariables: [toSecretEnvVar(secretVersion12)] },
      ]);

      expect(pruned).to.have.deep.members([secretVersion11, secretVersion21].map(toSecretEnvVar));
      expect(pruned).to.have.length(2);
    });

    it("resolves 'latest' secrets and properly prunes it", async () => {
      listSecretsStub.resolves([secret1, secret2]);
      listSecretVersionsStub.onFirstCall().resolves([secretVersion11, secretVersion12]);
      listSecretVersionsStub.onSecondCall().resolves([secretVersion21]);
      getSecretVersionStub.resolves(secretVersion12);

      const pruned = await secrets.pruneSecrets({ projectId: "project", projectNumber: "12345" }, [
        {
          ...ENDPOINT,
          secretEnvironmentVariables: [{ ...toSecretEnvVar(secretVersion12), version: "latest" }],
        },
      ]);

      expect(pruned).to.have.deep.members([secretVersion11, secretVersion21].map(toSecretEnvVar));
      expect(pruned).to.have.length(2);
    });
  });
});
