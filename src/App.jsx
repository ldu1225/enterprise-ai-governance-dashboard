import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import StandardDashboard from './components/StandardDashboard';
import CustomDashboardStudio from './components/CustomDashboardStudio';
import VersionHistoryModal from './components/VersionHistoryModal';

export default function App() {
  const [activeTab, setActiveTab] = useState('standard');
  const [versions, setVersions] = useState([]);
  const [currentVersion, setCurrentVersion] = useState(null);
  const [showVersionModal, setShowVersionModal] = useState(false);

  useEffect(() => {
    fetchVersions();
  }, []);

  const fetchVersions = async () => {
    try {
      const res = await fetch('http://localhost:8088/api/dashboard/versions');
      const data = await res.json();
      setVersions(data);
      if (data.length > 0 && !currentVersion) {
        setCurrentVersion(data[0]);
      }
    } catch (err) {
      console.error("Failed to fetch versions:", err);
    }
  };

  const handleSaveNewVersion = async (newVersionPayload) => {
    try {
      const res = await fetch('http://localhost:8088/api/dashboard/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newVersionPayload)
      });
      const data = await res.json();
      if (data.status === 'success') {
        setVersions(data.versions);
        setCurrentVersion(data.newVersion);
      }
    } catch (err) {
      console.error("Failed to save version:", err);
    }
  };

  const handleSelectVersion = (selectedVer) => {
    setCurrentVersion(selectedVer);
  };

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8 max-w-[1700px] mx-auto">
      {/* Top Navigation & Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentVersion={currentVersion}
        onOpenVersionModal={() => setShowVersionModal(true)}
      />

      {/* Tab Contents */}
      <main>
        {activeTab === 'standard' ? (
          <StandardDashboard />
        ) : (
          <CustomDashboardStudio
            currentVersion={currentVersion}
            onSaveVersion={handleSaveNewVersion}
          />
        )}
      </main>

      {/* Version Control Modal */}
      {showVersionModal && (
        <VersionHistoryModal
          versions={versions}
          currentVersion={currentVersion}
          onSelectVersion={handleSelectVersion}
          onClose={() => setShowVersionModal(false)}
        />
      )}
    </div>
  );
}
