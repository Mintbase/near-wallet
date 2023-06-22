import * as rudderanalytics from 'rudder-sdk-js';

import Environments from '../../../../../features/environments.json';
import { NEAR_WALLET_ENV } from '../../config';
import { KEY_ACTIVE_ACCOUNT_ID } from '../../utils/wallet';


export let rudderAnalyticsReady = false;
const DATA_PLANE_URL = 'https://near.dataplane.rudderstack.com';
const SUPPORTED_ENVIRONMENTS = [
    Environments.MAINNET_NEARORG,
    Environments.MAINNET_STAGING_NEARORG
];

export const initAnalytics = () => {
    return new Promise((resolve) => {
        if (rudderAnalyticsReady) {
            resolve();
            return;
        }

        if (!SUPPORTED_ENVIRONMENTS.includes(NEAR_WALLET_ENV)) {
            resolve();
            return;
        }
      
        const rudderAnalyticsKey = Environments.MAINNET_NEARORG === NEAR_WALLET_ENV
            ? '2RPBJoVn6SRht1E7FnPEZLcpNVh'
            : '2RPBBhH1Dka2bYG6HKQmvkzNUdz';
    
        rudderanalytics.load(rudderAnalyticsKey, DATA_PLANE_URL);
        rudderanalytics.ready(() => {
            rudderAnalyticsReady = true;
            resolve();
        }); 
    });
};

export const recordWalletMigrationEvent = (eventLabel, properties = {}) => {
    if (!rudderAnalyticsReady) {
        return;
    }

    try {
        const accountId = localStorage.getItem(KEY_ACTIVE_ACCOUNT_ID);
        rudderanalytics.track(eventLabel, { ...properties, userId: accountId });
    } catch (e) {
        console.error(e);
    }
};

export const recordWalletMigrationState = (traits = {}, fallBackAccountId) => {
    if (!rudderAnalyticsReady) {
        return;
    }

    try {
        const accountId = localStorage.getItem(KEY_ACTIVE_ACCOUNT_ID) || fallBackAccountId;
        rudderanalytics.identify(
            accountId,
            {
                ...traits,
                userAgent: navigator?.userAgent || 'Unknown',
            },
        );
    } catch (e) {
        console.error(e);
    }
};

export const resetUserState = () => {
    if (!rudderAnalyticsReady) {
        return;
    }
    return rudderanalytics.reset();
};