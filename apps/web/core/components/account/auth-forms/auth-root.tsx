/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// plane imports
import { useTranslation } from "@plane/i18n";
import { OAuthOptions } from "@plane/ui";
import { getOAuthButtonText } from "@plane/utils";
import { getPpmTranslation, isPpmShellEnabled } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
// helpers
import type { TAuthErrorInfo } from "@/helpers/authentication.helper";
import {
  EAuthModes,
  EAuthSteps,
  EAuthenticationErrorCodes,
  EErrorAlertType,
  authErrorHandler,
} from "@/helpers/authentication.helper";
// hooks
import { useOAuthConfig } from "@/hooks/oauth";
import { useInstance } from "@/hooks/store/use-instance";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// local imports
import { TermsAndConditions } from "../terms-and-conditions";
import { AuthBanner } from "./auth-banner";
import { AuthHeader, AuthHeaderBase } from "./auth-header";
import { AuthFormRoot } from "./form-root";

type TAuthRoot = {
  authMode: EAuthModes;
};

const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

export const AuthRoot = observer(function AuthRoot(props: TAuthRoot) {
  const ppmT = usePpmTranslation();
  // PPM line L: errors in the interface language
  const { currentLocale } = useTranslation();
  //router
  const searchParams = useSearchParams();
  // query params
  const emailParam = searchParams.get("email");
  const invitation_id = searchParams.get("invitation_id");
  const workspaceSlug = searchParams.get("slug");
  const error_code = searchParams.get("error_code");
  // props
  const { authMode: currentAuthMode } = props;
  // states
  const [authMode, setAuthMode] = useState<EAuthModes | undefined>(undefined);
  const [authStep, setAuthStep] = useState<EAuthSteps>(EAuthSteps.EMAIL);
  const [email, setEmail] = useState(emailParam ? emailParam.toString() : "");
  const [errorInfo, setErrorInfo] = useState<TAuthErrorInfo | undefined>(undefined);
  // store hooks
  const { config } = useInstance();
  // derived values
  const oAuthActionText = IS_PPM_SHELL_ENABLED
    ? ppmT(authMode === EAuthModes.SIGN_UP ? "auth.sign_up" : "auth.sign_in")
    : authMode === EAuthModes.SIGN_UP
      ? "Sign up"
      : "Sign in";
  const { isOAuthEnabled, oAuthOptions: upstreamOAuthOptions } = useOAuthConfig(oAuthActionText);
  // PPM line L: «Войти через Google» instead of the upstream "<action> with Google" glued to a translated action.
  const oAuthOptions = IS_PPM_SHELL_ENABLED
    ? upstreamOAuthOptions.map((option) => ({
        ...option,
        text:
          getOAuthButtonText(option.id, authMode === EAuthModes.SIGN_UP ? "sign_up" : "sign_in", (key) =>
            getPpmTranslation(currentLocale, key as TPpmTranslationKey)
          ) ?? option.text,
      }))
    : upstreamOAuthOptions;
  const isEmailBasedAuthEnabled = config?.is_email_password_enabled || config?.is_magic_login_enabled;
  const noAuthMethodsAvailable = !isOAuthEnabled && !isEmailBasedAuthEnabled;

  useEffect(() => {
    if (!authMode && currentAuthMode) setAuthMode(currentAuthMode);
  }, [currentAuthMode, authMode]);

  useEffect(() => {
    if (error_code && authMode) {
      const errorhandler = authErrorHandler(
        error_code?.toString() as EAuthenticationErrorCodes,
        undefined,
        currentLocale
      );
      if (errorhandler) {
        // password error handler
        if ([EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_UP].includes(errorhandler.code)) {
          setAuthMode(EAuthModes.SIGN_UP);
          setAuthStep(EAuthSteps.PASSWORD);
        }
        if ([EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN].includes(errorhandler.code)) {
          setAuthMode(EAuthModes.SIGN_IN);
          setAuthStep(EAuthSteps.PASSWORD);
        }
        // magic_code error handler
        if (
          [
            EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_UP,
            EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP,
            EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP,
            EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP,
          ].includes(errorhandler.code)
        ) {
          setAuthMode(EAuthModes.SIGN_UP);
          setAuthStep(EAuthSteps.UNIQUE_CODE);
        }
        if (
          [
            EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_IN,
            EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN,
            EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN,
            EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN,
          ].includes(errorhandler.code)
        ) {
          setAuthMode(EAuthModes.SIGN_IN);
          setAuthStep(EAuthSteps.UNIQUE_CODE);
        }

        setErrorInfo(errorhandler);
      }
    }
  }, [error_code, authMode, currentLocale]);

  if (!authMode) return <></>;

  if (noAuthMethodsAvailable) {
    return (
      <AuthContainer>
        <AuthHeaderBase
          header={IS_PPM_SHELL_ENABLED ? ppmT("auth.no_methods_title") : "No authentication methods available"}
          subHeader={
            IS_PPM_SHELL_ENABLED
              ? ppmT("auth.no_methods_description")
              : "Please contact your administrator to enable authentication for your instance."
          }
        />
      </AuthContainer>
    );
  }

  return (
    <AuthContainer>
      {errorInfo && errorInfo?.type === EErrorAlertType.BANNER_ALERT && (
        <AuthBanner message={errorInfo.message} handleBannerData={(value) => setErrorInfo(value)} />
      )}
      <AuthHeader
        workspaceSlug={workspaceSlug?.toString() || undefined}
        invitationId={invitation_id?.toString() || undefined}
        invitationEmail={email || undefined}
        authMode={authMode}
        currentAuthStep={authStep}
      />
      {isOAuthEnabled && (
        <OAuthOptions
          options={oAuthOptions}
          compact={authStep === EAuthSteps.PASSWORD}
          showDivider={isEmailBasedAuthEnabled}
          dividerText={IS_PPM_SHELL_ENABLED ? ppmT("auth.or") : undefined}
        />
      )}
      {isEmailBasedAuthEnabled && (
        <AuthFormRoot
          authStep={authStep}
          authMode={authMode}
          email={email}
          setEmail={(nextEmail) => setEmail(nextEmail)}
          setAuthMode={(nextAuthMode) => setAuthMode(nextAuthMode)}
          setAuthStep={(nextAuthStep) => setAuthStep(nextAuthStep)}
          setErrorInfo={(nextErrorInfo) => setErrorInfo(nextErrorInfo)}
          currentAuthMode={currentAuthMode}
        />
      )}
      <TermsAndConditions authType={authMode} />
    </AuthContainer>
  );
});

function AuthContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-10 flex w-full flex-grow flex-col items-center justify-center py-6">
      <div className="relative flex w-full max-w-[22.5rem] flex-col gap-6">{children}</div>
    </div>
  );
}
