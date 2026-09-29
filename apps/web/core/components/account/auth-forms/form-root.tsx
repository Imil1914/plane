/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import { EAuthModes, EAuthSteps } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { IEmailCheckData } from "@plane/types";
// helpers
import type { TAuthErrorInfo } from "@/helpers/authentication.helper";
import { authErrorHandler } from "@/helpers/authentication.helper";
// hooks
import { useInstance } from "@/hooks/store/use-instance";
import { useAppRouter } from "@/hooks/use-app-router";
// services
import { AuthService } from "@/services/auth.service";
// local components
import { AuthAccountNotFound } from "./account-not-found";
import { AuthEmailForm } from "./email";
import { resolveEmailCheckOutcome } from "./email-check-outcome";
import { AuthPasswordForm } from "./password";
import { AuthUniqueCodeForm } from "./unique-code";

type TAuthFormRoot = {
  authStep: EAuthSteps;
  authMode: EAuthModes;
  email: string;
  setEmail: (email: string) => void;
  setAuthMode: (authMode: EAuthModes) => void;
  setAuthStep: (authStep: EAuthSteps) => void;
  setErrorInfo: (errorInfo: TAuthErrorInfo | undefined) => void;
  currentAuthMode: EAuthModes;
};

const authService = new AuthService();

export const AuthFormRoot = observer(function AuthFormRoot(props: TAuthFormRoot) {
  const { authStep, authMode, email, setEmail, setAuthMode, setAuthStep, setErrorInfo, currentAuthMode } = props;
  // router
  const router = useAppRouter();
  // PPM line L: errors in the interface language
  const { currentLocale } = useTranslation();
  // query params
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next_path");
  // states
  const [isExistingEmail, setIsExistingEmail] = useState(false);
  // Sign-in page, unknown e-mail: the step to open if the person chooses to create an account after all.
  const [notFoundStep, setNotFoundStep] = useState<EAuthSteps | undefined | null>(null);
  // hooks
  const { config } = useInstance();

  const isSMTPConfigured = config?.is_smtp_configured || false;

  const openStep = (step: EAuthSteps | undefined, emailAddress: string) => {
    if (step === EAuthSteps.UNIQUE_CODE) {
      setAuthStep(EAuthSteps.UNIQUE_CODE);
      generateEmailUniqueCode(emailAddress);
    } else if (step === EAuthSteps.PASSWORD) {
      setAuthStep(EAuthSteps.PASSWORD);
    }
  };

  // submit handler- email verification
  const handleEmailVerification = async (data: IEmailCheckData) => {
    setEmail(data.email);
    setErrorInfo(undefined);
    setNotFoundStep(null);
    await authService
      .emailCheck(data)
      .then(async (response) => {
        const outcome = resolveEmailCheckOutcome(response, currentAuthMode);
        setIsExistingEmail(response.existing);
        if (outcome.kind === "not_found") {
          setNotFoundStep(outcome.step);
          return;
        }
        if (outcome.mode !== authMode) setAuthMode(outcome.mode);
        openStep(outcome.step, data.email);
      })
      .catch((error) => {
        const errorhandler = authErrorHandler(error?.error_code?.toString(), data?.email || undefined, currentLocale);
        if (errorhandler?.type) setErrorInfo(errorhandler);
      });
  };

  const handleEmailClear = () => {
    setAuthMode(currentAuthMode);
    setErrorInfo(undefined);
    setEmail("");
    setAuthStep(EAuthSteps.EMAIL);
    const base = currentAuthMode === EAuthModes.SIGN_IN ? `/` : "/sign-up";
    // G2.2 review round 1 (#4): keep next_path across this reset — otherwise a person who arrived from the Git
    // server's «Войти через PPM» loses their way back the moment they clear a mistyped email.
    router.push(nextPath ? `${base}?next_path=${nextPath}` : base);
  };

  // generating the unique code
  const generateEmailUniqueCode = async (email: string): Promise<{ code: string } | undefined> => {
    if (!isSMTPConfigured) return;
    const payload = { email: email };
    return await authService
      .generateUniqueCode(payload)
      .then(() => ({ code: "" }))
      .catch((error) => {
        const errorhandler = authErrorHandler(error?.error_code?.toString(), undefined, currentLocale);
        if (errorhandler?.type) setErrorInfo(errorhandler);
        throw error;
      });
  };

  if (authStep === EAuthSteps.EMAIL) {
    return (
      <>
        <AuthEmailForm
          defaultEmail={email}
          onSubmit={handleEmailVerification}
          onEmailChange={() => setNotFoundStep(null)}
        />
        {notFoundStep !== null && (
          <AuthAccountNotFound
            signUpOpen={Boolean(config?.enable_signup)}
            onCreateAccount={() => {
              const step = notFoundStep;
              setNotFoundStep(null);
              setAuthMode(EAuthModes.SIGN_UP);
              openStep(step, email);
            }}
          />
        )}
      </>
    );
  }
  if (authStep === EAuthSteps.UNIQUE_CODE) {
    return (
      <AuthUniqueCodeForm
        mode={authMode}
        email={email}
        isExistingEmail={isExistingEmail}
        handleEmailClear={handleEmailClear}
        generateEmailUniqueCode={generateEmailUniqueCode}
        nextPath={nextPath || undefined}
      />
    );
  }
  if (authStep === EAuthSteps.PASSWORD) {
    return (
      <AuthPasswordForm
        mode={authMode}
        isSMTPConfigured={isSMTPConfigured}
        email={email}
        handleEmailClear={handleEmailClear}
        handleAuthStep={(step: EAuthSteps) => {
          if (step === EAuthSteps.UNIQUE_CODE) generateEmailUniqueCode(email);
          setAuthStep(step);
        }}
        nextPath={nextPath || undefined}
      />
    );
  }

  return <></>;
});
