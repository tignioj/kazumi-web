import React from 'react';
import { PageHeading } from '../../components/PageHeading.jsx';
import { NetworkSettings } from './NetworkSettings.jsx';

export function ProxySettings({ network, notify }) {
  return (
    <>
      <PageHeading
        eyebrow="PROXY & ROUTING"
        title="代理设置"
        description="管理代理出口，为片源与各类请求选择合适的连接方式。"
      />
      <div className="settings-layout">
        <NetworkSettings request={network} notify={notify} />
      </div>
    </>
  );
}
