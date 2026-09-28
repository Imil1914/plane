/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (B2, B4): меню «Статус ▾», «Исполнитель ▾», «Спринт ▾» панели. Та же механика, что у выпадающих списков
// свойств задачи (Headless UI Combobox + useDropdown + popper): поиск, стрелки, Enter, Esc; список открывается вверх и
// живёт в портале, чтобы его не обрезал прокручиваемый список. Неактивное меню — та же кнопка (фокус не теряется,
// пока идёт действие) с aria-disabled и подсказкой.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePopper } from "react-popper";
import { Combobox } from "@headlessui/react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "@plane/propel/icons";
import { cn } from "@plane/utils";
import { useDropdown } from "@/hooks/use-dropdown";
import { getPpmBulkButtonClassName } from "./action-bar";

export type TPpmBulkPickerOption = {
  value: string;
  label: string;
  /** Иконка слева: статус, аватар, спринт. */
  icon?: ReactNode;
  /** Подпись справа: «текущий», «будущий». */
  meta?: string;
  /** По чему ещё искать (кроме подписи). */
  query?: string;
  /** Пункт уже у всех выделенных задач — отмечен галочкой. */
  isCurrent?: boolean;
};

type TPpmBulkPickerProps = {
  id: string;
  label: string;
  /** Почему меню неактивно; null — активно. */
  hint: string | null;
  busy?: boolean;
  /** undefined — варианты ещё загружаются. */
  options: TPpmBulkPickerOption[] | undefined;
  onOpen?: () => void;
  onSelect: (value: string) => void;
  /** Пояснение над списком: «Заменит исполнителей выделенных задач на выбранного». */
  menuHint?: string;
  searchPlaceholder: string;
  noMatchesText: string;
  loadingText: string;
  emptyText: string;
};

/**
 * D-2: что делать с клавишей в обёртке Combobox, до общего useDropdownKeyDown. Неактивное меню клавиш не получает.
 * Меню уже закрыто — Esc не наш: раньше его всё равно глотали (stopPropagation+preventDefault), событие доходило до
 * document с defaultPrevented=true, и панель (root.tsx:156) не снимала выделение вторым Esc. Отдаём такой Esc панели —
 * как если бы фокус был не в меню, а на самой панели. Остальные клавиши (Enter открывает меню, стрелки, Tab) всегда
 * идут в общий обработчик — как раньше, и поведение открытого меню/других выпадающих списков не меняется.
 */
export function shouldPpmBulkPickerConsumeKeyDown(key: string, isOpen: boolean, inactive: boolean): boolean {
  if (inactive) return false;
  if (key === "Escape") return isOpen;
  return true;
}

export function PpmBulkPicker(props: TPpmBulkPickerProps) {
  const {
    id,
    label,
    hint,
    busy = false,
    options,
    onOpen,
    onSelect,
    menuHint,
    searchPlaceholder,
    noMatchesText,
    loadingText,
    emptyText,
  } = props;
  // refs
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // states
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null);
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // popper: над кнопкой, панель внизу списка
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    placement: "top-start",
    modifiers: [{ name: "preventOverflow", options: { padding: 12 } }],
  });
  const { handleClose, handleKeyDown, handleOnClick, searchInputKeyDown } = useDropdown({
    dropdownRef,
    inputRef,
    isOpen,
    onOpen,
    query,
    setIsOpen,
    setQuery,
  });

  const inactive = busy || !!hint;
  const shownHint = busy ? null : hint;
  const hintId = `${id}-hint`;

  // Меню стало неактивным, пока было открыто (началось действие) — закрываем список.
  useEffect(() => {
    if (inactive) setIsOpen(false);
  }, [inactive]);

  const needle = query.trim().toLowerCase();
  const filteredOptions = options?.filter(
    (option) => !needle || `${option.label} ${option.query ?? ""}`.toLowerCase().includes(needle)
  );
  const listId = `${id}-options`;

  // Выбор или Esc возвращают фокус на кнопку меню — клавиатура остаётся в панели.
  const handleSelect = (value: string | null) => {
    if (!value) return;
    onSelect(value);
    handleClose();
    referenceElement?.focus();
  };
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!shouldPpmBulkPickerConsumeKeyDown(event.key, isOpen, inactive)) return;
    const isEscape = event.key === "Escape";
    handleKeyDown(event);
    if (isEscape) referenceElement?.focus();
  };
  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!inactive) return handleOnClick(event);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    // Клавиши меню ловит обёртка Combobox — как у выпадающих списков свойств задачи (dropdowns/state/base.tsx).
    // oxlint-disable-next-line jsx_a11y/no-static-element-interactions
    <Combobox
      as="div"
      ref={dropdownRef}
      className="relative"
      value={null}
      onChange={handleSelect}
      onKeyDown={handleMenuKeyDown}
    >
      {/* Своя кнопка, не Combobox.Button: та ставит tabIndex=-1 и перекрывает aria-expanded — меню должно быть
          доступно с Tab и честно говорить, открыто ли оно. */}
      <button
        ref={setReferenceElement}
        type="button"
        id={id}
        className={getPpmBulkButtonClassName("default", inactive)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-disabled={inactive || undefined}
        aria-describedby={shownHint ? hintId : undefined}
        title={shownHint ?? undefined}
        onClick={handleButtonClick}
      >
        <span>{label}</span>
        <ChevronDownIcon className="size-3 flex-shrink-0" aria-hidden="true" />
      </button>
      {shownHint && (
        <span id={hintId} className="sr-only">
          {shownHint}
        </span>
      )}
      {isOpen &&
        !inactive &&
        createPortal(
          <Combobox.Options data-prevent-outside-click static>
            <div
              id={listId}
              ref={setPopperElement}
              className="z-30 my-1 w-64 rounded-md border-[0.5px] border-subtle-1 bg-surface-1 px-2 py-2.5 text-13 shadow-raised-200 focus:outline-none"
              style={styles.popper}
              {...attributes.popper}
            >
              {menuHint && <p className="mb-2 px-1 text-12 leading-4 text-tertiary">{menuHint}</p>}
              <div className="flex items-center gap-1.5 rounded-sm border border-subtle bg-surface-2 px-2">
                <SearchIcon className="size-3.5 flex-shrink-0 text-placeholder" aria-hidden="true" />
                <Combobox.Input
                  as="input"
                  ref={inputRef}
                  className="w-full bg-transparent py-1 text-12 text-secondary placeholder:text-placeholder focus:outline-none"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  displayValue={() => query}
                  onKeyDown={searchInputKeyDown}
                />
              </div>
              <div className="vertical-scrollbar mt-2 scrollbar-xs max-h-60 space-y-0.5 overflow-y-auto">
                {!filteredOptions ? (
                  <p className="px-1.5 py-1 text-12 text-placeholder italic">{loadingText}</p>
                ) : filteredOptions.length === 0 ? (
                  <p className="px-1.5 py-1 text-12 text-placeholder italic">{needle ? noMatchesText : emptyText}</p>
                ) : (
                  filteredOptions.map((option) => (
                    <Combobox.Option
                      key={option.value}
                      value={option.value}
                      className={({ active }) =>
                        cn(
                          "flex w-full cursor-pointer items-center gap-2 truncate rounded-sm px-1.5 py-1.5 text-secondary select-none",
                          { "bg-layer-transparent-hover text-primary": active }
                        )
                      }
                    >
                      {option.icon && <span className="grid flex-shrink-0 place-items-center">{option.icon}</span>}
                      <span className="flex-grow truncate">{option.label}</span>
                      {option.meta && <span className="flex-shrink-0 text-12 text-tertiary">{option.meta}</span>}
                      {option.isCurrent && <CheckIcon className="size-3.5 flex-shrink-0" aria-hidden="true" />}
                    </Combobox.Option>
                  ))
                )}
              </div>
            </div>
          </Combobox.Options>,
          document.body
        )}
    </Combobox>
  );
}
