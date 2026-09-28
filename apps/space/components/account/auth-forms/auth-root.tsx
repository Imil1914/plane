/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// plane imports
import { SitesAuthService } from "@plane/services";
import type { IEmailCheckData } from "@plane/types";
import { OAuthOptions } from "@plane/ui";
import { getOAuthButtonText } from "@plane/utils";
import { getPpmTranslation, resolvePpmLocale } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
// helpers
import type { TAuthErrorInfo } from "@/helpers/authentication.helper";
import { EErrorAlertType, authErrorHandler, EAuthenticationErrorCodes } from "@/helpers/authentication.helper";
import { IS_PPM_SHELL_ENABLED, useAuthLanguage } from "@/helpers/ppm-auth-language";
// hooks
import { useOAuthConfig } from "@/hooks/oauth";
import { useInstance } from "@/hooks/store/use-instance";
// types
import { EAuthModes, EAuthSteps } from "@/types/auth";
// local imports
import { TermsAndConditions } from "../terms-and-conditions";
import { AuthBanner } from "./auth-banner";
import { AuthHeader } from "./auth-header";
import { AuthEmailForm } from "./email";
import { AuthPasswordForm } from "./password";
import { AuthUniqueCodeForm } from "./unique-code";

const authService = new SitesAuthService();

export const AuthRoot = observer(function AuthRoot() {
  // router params
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") || undefined;
  const error_code = searchParams.get("error_code") || undefined;
  const nextPath = searchParams.get("next_path") || undefined;
  // states
  const [authMode, setAuthMode] = useState<EAuthModes>(EAuthModes.SIGN_UP);
  const [authStep, setAuthStep] = useState<EAuthSteps>(EAuthSteps.EMAIL);
  const [email, setEmail] = useState(emailParam ? emailParam.toString() : "");
  const [errorInfo, setErrorInfo] = useState<TAuthErrorInfo | undefined>(undefined);
  const [isPasswordAutoset, setIsPasswordAutoset] = useState(true);
  // hooks
  const { config } = useInstance();
  // PPM line L: the interface language of the sign-in screens
  const { language, t } = useAuthLanguage();

  useEffect(() => {
    if (error_code) {
      const errorhandler = authErrorHandler(error_code?.toString() as EAuthenticationErrorCodes, undefined, language);
      if (errorhandler) {
        if (errorhandler.code === EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN) {
          setAuthMode(EAuthModes.SIGN_IN);
          setAuthStep(EAuthSteps.PASSWORD);
        }
        if (errorhandler.code === EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_UP) {
          setAuthMode(EAuthModes.SIGN_UP);
          setAuthStep(EAuthSteps.PASSWORD);
        }
        if (
          [
            EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_IN,
            EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN,
            EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN,
          ].includes(errorhandler.code)
        ) {
          setAuthMode(EAuthModes.SIGN_IN);
          setAuthStep(EAuthSteps.UNIQUE_CODE);
        }
        if (
          [
            EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_UP,
            EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP,
            EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP,
          ].includes(errorhandler.code)
        ) {
          setAuthMode(EAuthModes.SIGN_UP);
          setAuthStep(EAuthSteps.UNIQUE_CODE);
        }
        setErrorInfo(errorhandler);
      }
    }
  }, [error_code, language]);

  const isSMTPConfigured = config?.is_smtp_configured || false;
  const isMagicLoginEnabled = config?.is_magic_login_enabled || false;
  const isEmailPasswordEnabled = config?.is_email_password_enabled || false;
  const oAuthActionText = authMode === EAuthModes.SIGN_UP ? "Sign up" : "Sign in";
  const { isOAuthEnabled, oAuthOptions: upstreamOAuthOptions } = useOAuthConfig(oAuthActionText);
  // PPM line L: «Войти через Google» instead of the upstream "<action> with Google".
  const oAuthOptions = IS_PPM_SHELL_ENABLED
    ? upstreamOAuthOptions.map((option) => ({
        ...option,
        text:
          getOAuthButtonText(option.id, authMode === EAuthModes.SIGN_UP ? "sign_up" : "sign_in", (key) =>
            getPpmTranslation(language, key as TPpmTranslationKey)
          ) ?? option.text,
      }))
    : upstreamOAuthOptions;

  // submit handler- email verification
  const handleEmailVerification = async (data: IEmailCheckData) => {
    setEmail(data.email);

    await authService
      .emailCheck(data)
      .then(async (response) => {
        let currentAuthMode: EAuthModes = response.existing ? EAuthModes.SIGN_IN : EAuthModes.SIGN_UP;
        if (response.existing) {
          currentAuthMode = EAuthModes.SIGN_IN;
          setAuthMode(() => EAuthModes.SIGN_IN);
        } else {
          currentAuthMode = EAuthModes.SIGN_UP;
          setAuthMode(() => EAuthModes.SIGN_UP);
        }

        if (currentAuthMode === EAuthModes.SIGN_IN) {
          if (isSMTPConfigured && isMagicLoginEnabled && response.status === "MAGIC_CODE") {
            setAuthStep(EAuthSteps.UNIQUE_CODE);
            generateEmailUniqueCode(data.email);
          } else if (isEmailPasswordEnabled) {
            setIsPasswordAutoset(false);
            setAuthStep(EAuthSteps.PASSWORD);
          } else {
            const errorhandler = authErrorHandler("5005" as EAuthenticationErrorCodes, undefined, language);
            setErrorInfo(errorhandler);
          }
        } else {
          if (isSMTPConfigured && isMagicLoginEnabled && response.status === "MAGIC_CODE") {
            setAuthStep(EAuthSteps.UNIQUE_CODE);
            generateEmailUniqueCode(data.email);
          } else if (isEmailPasswordEnabled) {
            setAuthStep(EAuthSteps.PASSWORD);
          } else {
            const errorhandler = authErrorHandler("5006" as EAuthenticationErrorCodes, undefined, language);
            setErrorInfo(errorhandler);
          }
        }
        return;
      })
      .catch((error) => {
        const errorhandler = authErrorHandler(error?.error_code?.toString(), data?.email || undefined, language);
        if (errorhandler?.type) setErrorInfo(errorhandler);
      });
  };

  // generating the unique code
  const generateEmailUniqueCode = async (email: string): Promise<{ code: string } | undefined> => {
    const payload = { email: email };
    return await authService
      .generateUniqueCode(payload)
      .then(() => ({ code: "" }))
      .catch((error) => {
        const errorhandler = authErrorHandler(error?.error_code.toString(), undefined, language);
        if (errorhandler?.type) setErrorInfo(errorhandler);
        throw error;
      });
  };

  return (
    <div
      className="mt-10 flex w-full flex-grow flex-col items-center justify-center py-6"
      lang={IS_PPM_SHELL_ENABLED ? resolvePpmLocale(language) : undefined}
    >
      <div className="relative flex w-full max-w-[22.5rem] flex-col gap-6">
        {errorInfo && errorInfo?.type === EErrorAlertType.BANNER_ALERT && (
          <AuthBanner bannerData={errorInfo} handleBannerData={(value) => setErrorInfo(value)} />
        )}
        <AuthHeader authMode={authMode} />
        {isOAuthEnabled && (
          <OAuthOptions
            options={oAuthOptions}
            compact={authStep === EAuthSteps.PASSWORD}
            dividerText={IS_PPM_SHELL_ENABLED ? t("auth.or") : undefined}
          />
        )}

        {authStep === EAuthSteps.EMAIL && <AuthEmailForm defaultEmail={email} onSubmit={handleEmailVerification} />}
        {authStep === EAuthSteps.UNIQUE_CODE && (
          <AuthUniqueCodeForm
            mode={authMode}
            email={email}
            nextPath={nextPath}
            handleEmailClear={() => {
              setEmail("");
              setAuthStep(EAuthSteps.EMAIL);
            }}
            generateEmailUniqueCode={generateEmailUniqueCode}
          />
        )}
        {authStep === EAuthSteps.PASSWORD && (
          <AuthPasswordForm
            mode={authMode}
            isPasswordAutoset={isPasswordAutoset}
            isSMTPConfigured={isSMTPConfigured}
            email={email}
            nextPath={nextPath}
            handleEmailClear={() => {
              setEmail("");
              setAuthStep(EAuthSteps.EMAIL);
            }}
            handleAuthStep={(step: EAuthSteps) => {
              if (step === EAuthSteps.UNIQUE_CODE) generateEmailUniqueCode(email);
              setAuthStep(step);
            }}
          />
        )}
        <TermsAndConditions isSignUp={authMode === EAuthModes.SIGN_UP ? true : false} />
      </div>
    </div>
  );
});
