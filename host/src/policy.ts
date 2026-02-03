export type SandboxPolicyRule = {
  allow?: string[];
  deny?: string[];
};

export type SandboxPolicy = {
  dns?: SandboxPolicyRule;
  http?: SandboxPolicyRule;
  tls?: SandboxPolicyRule;
};
