import Log from "../libraries/Log";
import OneSignalUtils from "../utils/OneSignalUtils";
import { ContextInterface } from "../models/Context";
import { NotSubscribedError, NotSubscribedReason } from "../errors/NotSubscribedError";
import MainHelper from '../helpers/MainHelper';
import AlreadySubscribedError from '../errors/AlreadySubscribedError';
import PermissionMessageDismissedError from '../errors/PermissionMessageDismissedError';
import PushPermissionNotGrantedError from '../errors/PushPermissionNotGrantedError';
import { PushPermissionNotGrantedErrorReason } from '../errors/PushPermissionNotGrantedError';
import { PermissionPromptType } from '../models/PermissionPromptType';
import { InvalidStateError, InvalidStateReason } from '../errors/InvalidStateError';
import { NotificationPermission } from '../models/NotificationPermission';
import { ResourceLoadState } from '../services/DynamicResourceLoader';
import Popover, { manageNotifyButtonStateWhilePopoverShows } from '../popover/Popover';
import { SlidedownPermissionMessageOptions } from '../models/AppConfig';
import TestHelper from '../helpers/TestHelper';
import InitHelper, { RegisterOptions } from '../helpers/InitHelper';

export interface AutoPromptOptions {
  force: boolean;
}

export class PromptsManager {
  private isAutoPromptShowing: boolean;

  constructor(_context: ContextInterface) {
    this.isAutoPromptShowing = false;
  }

  private async checkIfAutoPromptShouldBeShown(options: AutoPromptOptions = { force: false }): Promise<boolean> {
    /*
    Only show the popover if:
    - Notifications aren't already enabled
    - The user isn't manually opted out (if the user was manually opted out, we don't want to prompt the user)
    */
    if (this.isAutoPromptShowing) {
      throw new InvalidStateError(InvalidStateReason.RedundantPermissionMessage, {
        permissionPromptType: PermissionPromptType.SlidedownPermissionMessage
      });
    }

    const doNotPrompt = MainHelper.wasHttpsNativePromptDismissed();
    if (doNotPrompt && !options.force) {
      Log.info(new PermissionMessageDismissedError());
      return false;
    }

    const permission = await OneSignal.privateGetNotificationPermission();
    if (permission === NotificationPermission.Denied) {
      Log.info(new PushPermissionNotGrantedError(PushPermissionNotGrantedErrorReason.Blocked));
      return false;
    }

    const isEnabled = await OneSignal.privateIsPushNotificationsEnabled();
    if (isEnabled) {
      throw new AlreadySubscribedError();
    }

    const notOptedOut = await OneSignal.privateGetSubscription();
    if (!notOptedOut) {
      throw new NotSubscribedError(NotSubscribedReason.OptedOut);
    }

    return true;
  }

  public async internalShowAutoPrompt(options: AutoPromptOptions = { force: false }): Promise<void> {
    OneSignalUtils.logMethodCall("internalShowAutoPrompt", options);

    if (!OneSignal.config || !OneSignal.config.userConfig || !OneSignal.config.userConfig.promptOptions) {
      Log.error("OneSignal config was not initialized correctly. Aborting.");
      return;
    }

    const promptOptions = OneSignal.config.userConfig.promptOptions;
    if (!promptOptions.native.enabled && !promptOptions.slidedown.enabled) {
      Log.error("No suitable prompt type enabled.");
      return;
    }

    if (promptOptions.native && promptOptions.native.enabled && promptOptions.native.autoPrompt) {
      await this.internalShowNativePrompt();
    } else if (promptOptions.slidedown && promptOptions.slidedown.enabled && promptOptions.slidedown.autoPrompt) {
      await this.internalShowSlidedownPrompt(options);
    }
  }

  public async internalShowNativePrompt(): Promise<void> {
    OneSignalUtils.logMethodCall("internalShowNativePrompt");

    if (this.isAutoPromptShowing) {
      Log.debug("Already showing autopromt. Abort showing a native prompt.");
      return;
    }

    this.isAutoPromptShowing = true;
    MainHelper.markHttpPopoverShown();
    await InitHelper.registerForPushNotifications();
    this.isAutoPromptShowing = false;
    TestHelper.markHttpsNativePromptDismissed();
  }

  public async internalShowSlidedownPrompt(options: AutoPromptOptions = { force: false }): Promise<void> {
    OneSignalUtils.logMethodCall("internalShowSlidedownPrompt");

    if (this.isAutoPromptShowing) {
      Log.debug("Already showing autopromt. Abort showing a slidedown.");
      return;
    }

    try {
      const showPrompt = await this.checkIfAutoPromptShouldBeShown(options);
      if (!showPrompt) { return; }
    } catch(e) {
      Log.warn("checkIfAutoPromptShouldBeShown returned an error", e);
      return;
    }

    MainHelper.markHttpPopoverShown();

    const sdkStylesLoadResult = await OneSignal.context.dynamicResourceLoader.loadSdkStylesheet();
    if (sdkStylesLoadResult !== ResourceLoadState.Loaded) {
      Log.debug('Not showing slidedown permission message because styles failed to load.');
      return;
    }
    const slideDownOptions: SlidedownPermissionMessageOptions =
      MainHelper.getSlidedownPermissionMessageOptions(OneSignal.config.userConfig.promptOptions);

    this.installEventHooksForPopover();

    OneSignal.popover = new Popover(slideDownOptions);
    await OneSignal.popover.create();
    Log.debug('Showing Slidedown(Popover).');
  }

  public installEventHooksForPopover(): void {
    manageNotifyButtonStateWhilePopoverShows();

    OneSignal.emitter.once(Popover.EVENTS.SHOWN, () => {
      this.isAutoPromptShowing = true;
    });
    OneSignal.emitter.once(Popover.EVENTS.CLOSED, () => {
      this.isAutoPromptShowing = false;
    });
    OneSignal.emitter.once(Popover.EVENTS.ALLOW_CLICK, () => {
      if (OneSignal.popover) {
        OneSignal.popover.close();
      }
      Log.debug("Setting flag to not show the popover to the user again.");
      TestHelper.markHttpsNativePromptDismissed();
      const options: RegisterOptions = { autoAccept: true };
      InitHelper.registerForPushNotifications(options);
    });
    OneSignal.emitter.once(Popover.EVENTS.CANCEL_CLICK, () => {
      Log.debug("Setting flag to not show the popover to the user again.");
      TestHelper.markHttpsNativePromptDismissed();
    });
  }
}
