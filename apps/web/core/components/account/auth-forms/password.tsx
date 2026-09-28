/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// icons
import { Eye, EyeOff, Info, XCircle } from "lucide-react";
// plane imports
import { API_BASE_URL, E_PASSWORD_STRENGTH, AUTH_TRACKER_ELEMENTS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { CloseIcon } from "@plane/propel/icons";
import { Input, PasswordStrengthIndicator, Spinner } from "@plane/ui";
import { getPasswordStrength } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
// components
import { ForgotPasswordPopover } from "@/components/account/auth-forms/forgot-password-popover";
// constants
// helpers
import { EAuthModes, EAuthSteps } from "@/helpers/authentication.helper";
// services
import { AuthService } from "@/services/auth.service";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// local components
import { PasswordFieldHints, usePasswordFieldHints } from "./password-field-hints";
import { PpmPasswordStrengthIndicator } from "./password-strength";

const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

type Props = {
  email: string;
  isSMTPConfigured: boolean;
  mode: EAuthModes;
  handleEmailClear: () => void;
  handleAuthStep: (step: EAuthSteps) => void;
  nextPath: string | undefined;
};

type TPasswordFormValues = {
  email: string;
  password: string;
  confirm_password?: string;
};

const defaultValues: TPasswordFormValues = {
  email: "",
  password: "",
};

const authService = new AuthService();

export const AuthPasswordForm = observer(function AuthPasswordForm(props: Props) {
  const { email, isSMTPConfigured, handleAuthStep, handleEmailClear, mode, nextPath } = props;
  // plane imports
  const { t } = useTranslation();
  const ppmT = usePpmTranslation();
  // ref
  const formRef = useRef<HTMLFormElement>(null);
  // states
  const [passwordFormData, setPasswordFormData] = useState<TPasswordFormValues>({ ...defaultValues, email });
  const [showPassword, setShowPassword] = useState({
    password: false,
    retypePassword: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasswordInputFocused, setIsPasswordInputFocused] = useState(false);
  const [isRetryPasswordInputFocused, setIsRetryPasswordInputFocused] = useState(false);
  const [isBannerMessage, setBannerMessage] = useState(false);
  const [csrfError, setCsrfError] = useState(false);
  // PPM line L: Caps Lock / Russian layout / edge-space hints under the password field
  const passwordHints = usePasswordFieldHints("password-hints", IS_PPM_SHELL_ENABLED);

  const handleShowPassword = (key: keyof typeof showPassword) =>
    setShowPassword((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleFormChange = (key: keyof TPasswordFormValues, value: string) =>
    setPasswordFormData((prev) => ({ ...prev, [key]: value }));

  const redirectToUniqueCodeSignIn = async () => {
    handleAuthStep(EAuthSteps.UNIQUE_CODE);
  };

  const passwordSupport =
    mode === EAuthModes.SIGN_IN ? (
      <div className="w-full">
        {isSMTPConfigured ? (
          <Link
            data-ph-element={AUTH_TRACKER_ELEMENTS.FORGOT_PASSWORD_FROM_SIGNIN}
            href={`/accounts/forgot-password?email=${encodeURIComponent(email)}`}
            className="text-11 font-medium text-accent-primary"
          >
            {t("auth.common.forgot_password")}
          </Link>
        ) : (
          <ForgotPasswordPopover />
        )}
      </div>
    ) : (
      passwordFormData.password.length > 0 &&
      getPasswordStrength(passwordFormData.password) != E_PASSWORD_STRENGTH.STRENGTH_VALID &&
      (IS_PPM_SHELL_ENABLED ? (
        <PpmPasswordStrengthIndicator password={passwordFormData.password} isFocused={isPasswordInputFocused} />
      ) : (
        <PasswordStrengthIndicator password={passwordFormData.password} isFocused={isPasswordInputFocused} />
      ))
    );

  const isButtonDisabled = useMemo(
    () =>
      !(
        !isSubmitting &&
        !!passwordFormData.password &&
        (mode === EAuthModes.SIGN_UP ? passwordFormData.password === passwordFormData.confirm_password : true)
      ),
    [isSubmitting, mode, passwordFormData.confirm_password, passwordFormData.password]
  );

  const password = passwordFormData?.password ?? "";
  const confirmPassword = passwordFormData?.confirm_password ?? "";
  const renderPasswordMatchError = !isRetryPasswordInputFocused || confirmPassword.length >= password.length;

  const handleCSRFToken = async () => {
    if (!formRef.current) throw new Error("Authentication form is unavailable.");
    const token = await authService.requestCSRFToken();
    if (!token?.csrf_token) throw new Error("CSRF token is unavailable.");
    const csrfElement = formRef.current.querySelector("input[name=csrfmiddlewaretoken]");
    if (!(csrfElement instanceof HTMLInputElement)) throw new Error("CSRF field is unavailable.");
    csrfElement.value = token.csrf_token;
  };

  return (
    <>
      {isBannerMessage && mode === EAuthModes.SIGN_UP && (
        <div className="relative flex items-center gap-2 rounded-md border border-danger-strong/50 bg-danger-subtle p-2">
          <div className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            <Info size={16} className="text-danger-primary" />
          </div>
          <div className="w-full text-13 font-medium text-danger-primary">
            {t("auth.sign_up.errors.password.strength")}
          </div>
          <button
            type="button"
            className="relative ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-xs text-accent-primary/80 transition-all hover:bg-danger-subtle-hover"
            onClick={() => setBannerMessage(false)}
          >
            <CloseIcon className="h-4 w-4 shrink-0 text-danger-primary" />
          </button>
        </div>
      )}
      <form
        ref={formRef}
        className="space-y-4"
        method="POST"
        action={`${API_BASE_URL}/auth/${mode === EAuthModes.SIGN_IN ? "sign-in" : "sign-up"}/`}
        onSubmit={async (event) => {
          event.preventDefault(); // Prevent form from submitting by default
          const isPasswordValid =
            mode === EAuthModes.SIGN_UP
              ? getPasswordStrength(passwordFormData.password) === E_PASSWORD_STRENGTH.STRENGTH_VALID
              : true;
          if (isPasswordValid) {
            setIsSubmitting(true);
            setCsrfError(false);
            try {
              await handleCSRFToken();
              formRef.current?.submit(); // Manually submit the form if the condition is met
            } catch {
              setCsrfError(true);
              setIsSubmitting(false);
            }
          } else {
            setBannerMessage(true);
          }
        }}
        onError={() => {
          setIsSubmitting(false);
        }}
      >
        <input type="hidden" name="csrfmiddlewaretoken" />
        {csrfError && (
          <p className="text-13 text-danger-primary" role="alert">
            {ppmT("auth.csrf_error")}
          </p>
        )}
        <input type="hidden" value={passwordFormData.email} name="email" />
        {nextPath && <input type="hidden" value={nextPath} name="next_path" />}
        <div className="space-y-1">
          <label htmlFor="email" className="text-13 font-medium text-tertiary">
            {IS_PPM_SHELL_ENABLED ? ppmT("auth.email") : t("auth.common.email.label")}
          </label>
          <div className={`relative flex items-center rounded-md border border-strong bg-surface-1`}>
            <Input
              id="email"
              name="email"
              type="email"
              value={passwordFormData.email}
              onChange={(e) => handleFormChange("email", e.target.value)}
              placeholder={IS_PPM_SHELL_ENABLED ? ppmT("auth.email_placeholder") : t("auth.common.email.placeholder")}
              className={`h-10 w-full border-0 disable-autofill-style placeholder:text-placeholder`}
              disabled
            />
            {passwordFormData.email.length > 0 && (
              <button
                type="button"
                className="absolute right-3 size-5"
                onClick={handleEmailClear}
                aria-label={IS_PPM_SHELL_ENABLED ? ppmT("auth.clear_email") : t("aria_labels.auth_forms.clear_email")}
              >
                <XCircle className="size-5 stroke-placeholder" />
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="text-13 font-medium text-tertiary">
            {IS_PPM_SHELL_ENABLED
              ? ppmT(mode === EAuthModes.SIGN_IN ? "auth.password" : "auth.set_password")
              : mode === EAuthModes.SIGN_IN
                ? t("auth.common.password.label")
                : t("auth.common.password.set_password")}
          </label>
          <div className="relative flex items-center rounded-md bg-surface-1">
            <Input
              type={showPassword?.password ? "text" : "password"}
              id="password"
              name="password"
              value={passwordFormData.password}
              onChange={(e) => handleFormChange("password", e.target.value)}
              placeholder={
                IS_PPM_SHELL_ENABLED ? ppmT("auth.password_placeholder") : t("auth.common.password.placeholder")
              }
              className="h-10 w-full border border-strong !bg-surface-1 pr-12 disable-autofill-style placeholder:text-placeholder"
              onFocus={() => setIsPasswordInputFocused(true)}
              onBlur={() => {
                setIsPasswordInputFocused(false);
                passwordHints.resetCapsLock();
              }}
              autoComplete="off"
              {...passwordHints.inputProps}
            />
            <button
              type="button"
              onClick={() => handleShowPassword("password")}
              className="absolute right-3 grid size-5 place-items-center"
              aria-label={
                IS_PPM_SHELL_ENABLED
                  ? ppmT(showPassword?.password ? "auth.hide_password" : "auth.show_password")
                  : t(
                      showPassword?.password
                        ? "aria_labels.auth_forms.hide_password"
                        : "aria_labels.auth_forms.show_password"
                    )
              }
            >
              {showPassword?.password ? (
                <EyeOff className="size-5 stroke-placeholder" />
              ) : (
                <Eye className="size-5 stroke-placeholder" />
              )}
            </button>
          </div>
          {IS_PPM_SHELL_ENABLED && (
            <PasswordFieldHints
              id="password-hints"
              value={passwordFormData.password}
              isCapsLockOn={passwordHints.isCapsLockOn}
            />
          )}
          {passwordSupport}
        </div>

        {mode === EAuthModes.SIGN_UP && (
          <div className="space-y-1">
            <label htmlFor="confirm-password" className="text-13 font-medium text-tertiary">
              {IS_PPM_SHELL_ENABLED ? ppmT("auth.confirm_password") : t("auth.common.password.confirm_password.label")}
            </label>
            <div className="relative flex items-center rounded-md bg-surface-1">
              <Input
                type={showPassword?.retypePassword ? "text" : "password"}
                id="confirm-password"
                name="confirm_password"
                value={passwordFormData.confirm_password}
                onChange={(e) => handleFormChange("confirm_password", e.target.value)}
                placeholder={
                  IS_PPM_SHELL_ENABLED
                    ? ppmT("auth.confirm_password_placeholder")
                    : t("auth.common.password.confirm_password.placeholder")
                }
                className="h-10 w-full border border-strong !bg-surface-1 pr-12 disable-autofill-style placeholder:text-placeholder"
                onFocus={() => setIsRetryPasswordInputFocused(true)}
                onBlur={() => setIsRetryPasswordInputFocused(false)}
                autoComplete="off"
              />
              <button
                type="button"
                className="absolute right-3 grid size-5 place-items-center"
                aria-label={
                  IS_PPM_SHELL_ENABLED
                    ? ppmT(showPassword?.retypePassword ? "auth.hide_password" : "auth.show_password")
                    : t(
                        showPassword?.retypePassword
                          ? "aria_labels.auth_forms.hide_password"
                          : "aria_labels.auth_forms.show_password"
                      )
                }
                onClick={() => handleShowPassword("retypePassword")}
              >
                {showPassword?.retypePassword ? (
                  <EyeOff className="size-5 stroke-placeholder" />
                ) : (
                  <Eye className="size-5 stroke-placeholder" />
                )}
              </button>
            </div>
            {!!passwordFormData.confirm_password &&
              passwordFormData.password !== passwordFormData.confirm_password &&
              renderPasswordMatchError && (
                <span className="text-13 text-danger-primary">
                  {IS_PPM_SHELL_ENABLED ? ppmT("auth.password_mismatch") : t("auth.common.password.errors.match")}
                </span>
              )}
          </div>
        )}

        <div className="space-y-2.5">
          {mode === EAuthModes.SIGN_IN ? (
            <>
              <Button type="submit" variant="primary" className="w-full" size="xl" disabled={isButtonDisabled}>
                {isSubmitting ? (
                  <Spinner height="20px" width="20px" />
                ) : isSMTPConfigured ? (
                  IS_PPM_SHELL_ENABLED ? (
                    ppmT("auth.continue")
                  ) : (
                    t("common.continue")
                  )
                ) : IS_PPM_SHELL_ENABLED ? (
                  ppmT("auth.open_workspace")
                ) : (
                  t("common.go_to_workspace")
                )}
              </Button>
              {isSMTPConfigured && (
                <Button
                  type="button"
                  data-ph-element={AUTH_TRACKER_ELEMENTS.SIGN_IN_WITH_UNIQUE_CODE}
                  onClick={redirectToUniqueCodeSignIn}
                  variant="secondary"
                  className="w-full"
                  size="xl"
                >
                  {t("auth.common.sign_in_with_unique_code")}
                </Button>
              )}
            </>
          ) : (
            <Button type="submit" variant="primary" className="w-full" size="xl" disabled={isButtonDisabled}>
              {isSubmitting ? (
                <Spinner height="20px" width="20px" />
              ) : IS_PPM_SHELL_ENABLED ? (
                ppmT("auth.create_account")
              ) : (
                "Create account"
              )}
            </Button>
          )}
        </div>
      </form>
    </>
  );
});
