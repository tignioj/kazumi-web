import React from 'react';
import { PageHeading } from '../../components/PageHeading.jsx';
import { SourceSearch } from './SourceSearch.jsx';

export function Sources({ rules, onPlay, navigate }) {
  return (
    <>
      <PageHeading
        eyebrow="FIND YOUR NEXT EPISODE"
        title="故事的另一扇门"
        description="直接搜索已安装规则中的片源，找到后即可选择线路与剧集。"
      />
      <SourceSearch rules={rules} onPlay={onPlay} navigate={navigate} />
    </>
  );
}
